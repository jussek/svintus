import { createRoom } from '@/lib/rooms';
import { jsonBody, respond } from '@/lib/http';
export const runtime='nodejs';
export async function POST(request:Request){return respond(async()=>createRoom(await jsonBody(request)));}
