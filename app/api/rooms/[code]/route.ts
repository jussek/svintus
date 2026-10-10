import { getRoom,codeOf,tokenOf } from '@/lib/rooms';
import { respond } from '@/lib/http';
export const runtime='nodejs';
export async function GET(request:Request,context:{params:Promise<{code:string}>}){return respond(async()=>getRoom(codeOf((await context.params).code),tokenOf(request)));}
