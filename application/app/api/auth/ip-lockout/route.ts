import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse } from '../../types';
import { checkIpLockout, recordFailedAttempt, resetFailedAttempts } from '../../utils/ip-lockout';

/**
 * API endpoint to check if an IP is locked out
 */
export async function GET(req: NextRequest) {
  // Get the client IP
  const ip = req.headers.get('x-forwarded-for') || 
             req.headers.get('x-real-ip') || 
             'unknown';
  
  const { locked, remainingTime } = checkIpLockout(ip);
  
  return NextResponse.json<ApiResponse<{ locked: boolean; remainingTime: number }>>(
    {
      success: true,
      data: { locked, remainingTime }
    }
  );
}

/**
 * API endpoint to record a failed login attempt
 */
export async function POST(req: NextRequest) {
  // Get the client IP
  const ip = req.headers.get('x-forwarded-for') || 
             req.headers.get('x-real-ip') || 
             'unknown';
  
  const { locked, remainingTime } = recordFailedAttempt(ip);
  
  return NextResponse.json<ApiResponse<{ locked: boolean; remainingTime: number }>>(
    {
      success: true,
      data: { locked, remainingTime }
    }
  );
}

/**
 * API endpoint to reset failed login attempts after successful login
 */
export async function DELETE(req: NextRequest) {
  // Get the client IP
  const ip = req.headers.get('x-forwarded-for') || 
             req.headers.get('x-real-ip') || 
             'unknown';
  
  resetFailedAttempts(ip);
  
  return NextResponse.json<ApiResponse<null>>(
    {
      success: true
    }
  );
}
