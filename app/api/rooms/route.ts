import { createRoom, listRooms } from '@/lib/rooms';
import { jsonBody, respond } from '@/lib/http';
export const runtime='nodejs';
export async function GET(){return respond(listRooms);}
export async function POST(request:Request){return respond(async()=>createRoom(await jsonBody(request)));}
