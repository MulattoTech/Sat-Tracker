import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse } from '../../types';

/**
 * API endpoint to get the AUTH_LIFE value from environment variables
 */
export async function GET(req: NextRequest) {
  // Get the AUTH_LIFE value from environment variables, default to 30 minutes (1800 seconds)
  const authLife = parseInt(process.env.AUTH_LIFE || '1800', 10);
  
  return NextResponse.json<ApiResponse<number>>(
    {
      success: true,
      data: authLife
    }
  );
}
