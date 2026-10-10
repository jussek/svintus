import { roomAction,codeOf,tokenOf } from '@/lib/rooms';
import { jsonBody,respond } from '@/lib/http';
export const runtime='nodejs';
export async function POST(request:Request,context:{params:Promise<{code:string}>}){return respond(async()=>roomAction(codeOf((await context.params).code),tokenOf(request),await jsonBody(request),request.headers.get('x-action-id')));}
