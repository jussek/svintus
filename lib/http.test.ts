import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonBody, respond } from './http';
import { ApiError, codeOf, parseAction } from './rooms';

test('JSON API rejects oversized streamed requests, not just Content-Length',async()=>{
  const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(' '.repeat(4097)));controller.close();}});
  const request=new Request('https://test.invalid',{method:'POST',body:stream,duplex:'half'} as RequestInit);
  await assert.rejects(jsonBody(request),(error:unknown)=>error instanceof ApiError && error.status===413);
});
test('JSON API accepts Unicode names and rejects arrays and malformed bodies',async()=>{
  assert.deepEqual(await jsonBody(new Request('https://test.invalid',{method:'POST',body:JSON.stringify({name:'Хрюша'})})),{name:'Хрюша'});
  for(const body of ['[]','null','{'])await assert.rejects(jsonBody(new Request('https://test.invalid',{method:'POST',body})),ApiError);
});
test('action validation prevents malformed payloads and accepts the silent declare action',()=>{
  assert.deepEqual(parseAction({type:'declare'}),{type:'declare'});
  for(const body of [{type:123},{type:'play',cardId:'a',color:'purple'},{type:'chat',text:'x'.repeat(201)},{type:'catch',targetId:[]},{type:'unknown'}])assert.throws(()=>parseAction(body),ApiError);
  assert.equal(codeOf('abcd23'),'ABCD23');
  assert.throws(()=>codeOf('../../'),ApiError);
});
test('HTTP responses keep known errors readable and private state uncached',async()=>{
  const response=await respond(async()=>{throw new ApiError(401,'Сессия не найдена.');});
  assert.equal(response.status,401);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(await response.json(),{error:'Сессия не найдена.'});
});
