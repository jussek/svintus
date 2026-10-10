import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createGame, addPlayer, act, publicGame, type GameState, type Action } from './game';
import { advanceGame } from './bots';

type Session = { hash: string; requests: string[] };
type Room = { code: string; state: GameState; sessions: Record<string,Session>; version: number; created_at: string; updated_at: string };
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
let client: SupabaseClient | undefined;
function db() {
  if (!client) {
    const url=process.env.SUPABASE_URL, key=process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if(!url || !key) throw new ApiError(503,'Сервер игры ещё не подключён к базе данных.');
    client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(10000)})}});
  }
  return client;
}
const hash=(token:string)=>createHash('sha256').update(token).digest('hex');
const newSession=(providedToken?:string)=>{const token=providedToken??randomBytes(32).toString('base64url');return {token,session:{hash:hash(token),requests:[]} as Session};};
export function codeOf(value:string) { const code=value.toUpperCase(); if(!/^[A-Z2-9]{6}$/.test(code)) throw new ApiError(400,'Код комнаты состоит из шести букв или цифр.'); return code; }
function nameOf(value:unknown) {
  if(typeof value!=='string')throw new ApiError(400,'Введите имя.');
  const name=value.trim().replace(/[\p{Cc}\p{Cf}]/gu,'').replace(/\s+/g,' ');
  if(name.length<1 || name.length>24)throw new ApiError(400,'Имя должно содержать от 1 до 24 символов.');
  return name;
}
export function tokenOf(request:Request) {
  const token=request.headers.get('authorization')?.replace(/^Bearer /,'');
  if(!token || !/^[A-Za-z0-9_-]{43}$/.test(token))throw new ApiError(401,'Войдите в комнату заново или откройте её в том же браузере.');
  return token;
}
function findPlayer(room:Room, token:string) {
  const digest=Buffer.from(hash(token),'hex');
  return Object.keys(room.sessions).find(id=>{
    const saved=Buffer.from(room.sessions[id].hash,'hex');
    return saved.length===digest.length && timingSafeEqual(saved,digest);
  });
}
function playerOf(room:Room, token:string) {
  const playerId=findPlayer(room,token);
  if(!playerId)throw new ApiError(401,'Сессия комнаты не найдена.');
  return playerId;
}
async function read(code:string) {
  const {data,error}=await db().from('svintus_rooms').select('*').eq('code',code).maybeSingle();
  if(error)throw new ApiError(503,'Не удалось подключиться к комнате. Попробуйте ещё раз.');
  if(!data)throw new ApiError(404,'Комната не найдена. Проверьте код.');
  if(Date.now()-Date.parse(data.created_at)>24*3600*1000)throw new ApiError(410,'Комната закрыта через 24 часа. Создайте новую игру.');
  return data as Room;
}
async function write(room:Room,state:GameState,sessions=room.sessions) {
  const {data,error}=await db().from('svintus_rooms').update({state,sessions,version:room.version+1,updated_at:new Date().toISOString()}).eq('code',room.code).eq('version',room.version).select('code');
  if(error)throw new ApiError(503,'Не удалось сохранить ход. Повторите попытку.');
  return Boolean(data?.length);
}
function refreshNewPhase(state:GameState,previous:GameState,now:number) {
  if(state.clap && state.clap.id!==previous.clap?.id)state.clap.deadline=now+state.turnSeconds*1000;
  else if(!state.clap && state.turnDeadline!==null && (
    state.turnDeadline!==previous.turnDeadline || previous.clap!==null ||
    state.turnIndex!==previous.turnIndex || state.discardPile.at(-1)?.id!==previous.discardPile.at(-1)?.id
  ))state.turnDeadline=now+state.turnSeconds*1000;
  return state;
}
export async function createRoom(body:Record<string,unknown>) {
  const name=nameOf(body.name);const seconds=body.turnSeconds ?? 5;
  if(seconds!==2 && seconds!==3 && seconds!==5)throw new ApiError(400,'Время хода: 2, 3 или 5 секунд.');
  const playerId=randomUUID(), {token,session}=newSession(),state=createGame(playerId,name,seconds);
  const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for(let tries=0;tries<5;tries++){
    const code=Array.from(randomBytes(6),n=>alphabet[n%alphabet.length]).join('');
    const {error}=await db().from('svintus_rooms').insert({code,state,sessions:{[playerId]:session},version:0});
    if(!error)return {code,token,playerId,game:publicGame(state,playerId)};
    if(error.code!=='23505')throw new ApiError(503,'Не удалось создать комнату. Попробуйте позже.');
  }
  throw new ApiError(503,'Не удалось создать уникальный код комнаты.');
}
export async function joinRoom(code:string,body:Record<string,unknown>) {
  const name=nameOf(body.name);
  if(body.joinToken!==undefined && (typeof body.joinToken!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(body.joinToken)))throw new ApiError(400,'Некорректный идентификатор входа.');
  const playerId=randomUUID(), {token,session}=newSession(body.joinToken as string|undefined);
  for(let attempt=0;attempt<8;attempt++){
    const room=await read(code);
    // A lost response must not reserve a second seat: the browser keeps this
    // random token before posting and can recover the original session.
    const existingPlayerId=findPlayer(room,token);
    if(existingPlayerId)return {code,token,playerId:existingPlayerId,game:publicGame(room.state,existingPlayerId)};
    let state:GameState;
    try{state=addPlayer(room.state,playerId,name);}catch(e){throw new ApiError(409,e instanceof Error?e.message:'Не удалось войти.');}
    if(await write(room,state,{...room.sessions,[playerId]:session}))return {code,token,playerId,game:publicGame(state,playerId)};
  }
  throw new ApiError(409,'Кто-то присоединяется одновременно. Повторите вход.');
}
export async function getRoom(code:string,token:string) {
  const receivedAt=Date.now();
  for(let attempt=0;attempt<8;attempt++){
    const room=await read(code), playerId=playerOf(room,token), advanced=advanceGame(room.state,receivedAt);
    const state=advanced===room.state?advanced:refreshNewPhase(advanced,room.state,Date.now());
    if(state===room.state || await write(room,state))return {game:publicGame(state,playerId)};
  }
  throw new ApiError(409,'Стол обновляется. Повторите запрос.');
}
export async function roomAction(code:string,token:string,body:Record<string,unknown>,requestId:string|null) {
  const receivedAt=Date.now();
  if(requestId && !/^[a-zA-Z0-9_-]{8,64}$/.test(requestId))throw new ApiError(400,'Некорректный идентификатор хода.');
  const action=parseAction(body);
  for(let attempt=0;attempt<8;attempt++){
    const room=await read(code),playerId=playerOf(room,token);
    if(requestId && room.sessions[playerId].requests.includes(requestId))return {game:publicGame(room.state,playerId)};
    // Database latency must not let a bot overtake an already-arrived gesture.
    const advanced=advanceGame(room.state,receivedAt);
    let state:GameState;
    try {state=advanceGame(refreshNewPhase(act(advanced,playerId,action,receivedAt),room.state,Date.now()),Date.now());}
    catch(e){
      // A rejected human move must still preserve any due bot/timeout actions.
      if(advanced!==room.state && !await write(room,refreshNewPhase(advanced,room.state,Date.now())))continue;
      throw new ApiError(409,e instanceof Error?e.message:'Такой ход сейчас невозможен.');
    }
    const sessions=requestId?{...room.sessions,[playerId]:{...room.sessions[playerId],requests:[...room.sessions[playerId].requests,requestId].slice(-32)}}:room.sessions;
    if(await write(room,state,sessions))return {game:publicGame(state,playerId)};
  }
  throw new ApiError(409,'Другой игрок успел раньше. Обновите стол и повторите ход.');
}
export function parseAction(body:Record<string,unknown>):Action {
  const type=body.type;
  if(typeof type!=='string')throw new ApiError(400,'Неизвестное действие.');
  if(['start','next_round','add_bot','draw','pass','accept_penalty','clap','declare','break_silence'].includes(String(type)))return {type} as Action;
  if(type==='play'){
    if(typeof body.cardId!=='string' || body.cardId.length>80)throw new ApiError(400,'Выберите карту.');
    if(body.color!==undefined && !['red','orange','green','blue'].includes(String(body.color)))throw new ApiError(400,'Выберите один из четырёх цветов.');
    return {type,cardId:body.cardId,color:body.color} as Action;
  }
  if(type==='catch' || type==='remove_bot'){
    if(typeof body.targetId!=='string' || body.targetId.length>80)throw new ApiError(400,'Выберите игрока.');
    return {type,targetId:body.targetId};
  }
  if(type==='chat'){
    if(typeof body.text!=='string' || body.text.trim().length<1 || body.text.length>200)throw new ApiError(400,'Сообщение: от 1 до 200 символов.');
    return {type,text:body.text.trim().replace(/[\p{Cc}\p{Cf}]/gu,'')};
  }
  throw new ApiError(400,'Неизвестное действие.');
}
export async function health() {
  const {error}=await db().from('svintus_rooms').select('code',{count:'exact',head:true});
  if(error)throw new ApiError(503,'База данных игры недоступна.');
  return {ok:true,storage:'supabase',rules:'svintus-two-to-six-bots-no-reverse'};
}
