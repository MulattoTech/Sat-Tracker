import { NextRequest } from 'next/server';
import { recoveryUploadRoute } from '../../utils/recovery-upload-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: NextRequest): Promise<Response> { return recoveryUploadRoute(request, false); }
