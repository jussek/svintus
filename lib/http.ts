import { ApiError } from './rooms';
export async function jsonBody(request:Request):Promise<Record<string,unknown>> {
  if(Number(request.headers.get('content-length')??0)>4096)throw new ApiError(413,'Слишком большой запрос.');
  const reader=request.body?.getReader();
  if(!reader)throw new ApiError(400,'Пустой запрос.');
  const chunks:Uint8Array[]=[];let bytes=0;
  for(;;){
    const {value,done}=await reader.read();if(done)break;
    bytes+=value.byteLength;
    if(bytes>4096){await reader.cancel();throw new ApiError(413,'Слишком большой запрос.');}
    chunks.push(value);
  }
  const joined=new Uint8Array(bytes);let offset=0;
  for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.byteLength;}
  try{const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(joined));if(!body || typeof body!=='object' || Array.isArray(body))throw new Error();return body;}
  catch{throw new ApiError(400,'Некорректный запрос.');}
}
export async function respond(work:()=>Promise<unknown>) {
  try{return Response.json(await work(),{headers:{'Cache-Control':'no-store'}});}
  catch(error){
    const known=error instanceof ApiError;
    if(!known)console.error('Game API failed:',error instanceof Error?error.name:'unknown');
    return Response.json({error:known?error.message:'Не удалось выполнить запрос. Попробуйте ещё раз.'},{status:known?error.status:500,headers:{'Cache-Control':'no-store'}});
  }
}
