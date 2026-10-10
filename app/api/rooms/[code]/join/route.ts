import { joinRoom,codeOf } from '@/lib/rooms';
import { jsonBody,respond } from '@/lib/http';
export const runtime='nodejs';
export async function POST(request:Request,context:{params:Promise<{code:string}>}){return respond(async()=>joinRoom(codeOf((await context.params).code),await jsonBody(request)));}
