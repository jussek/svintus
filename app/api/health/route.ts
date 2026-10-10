import { health } from '@/lib/rooms';
import { respond } from '@/lib/http';
export const runtime='nodejs';
export async function GET(){return respond(health);}
