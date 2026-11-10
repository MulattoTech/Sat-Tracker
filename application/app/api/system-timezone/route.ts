import { NextResponse } from 'next/server';
import { getSystemTimezone } from '../utils/timezone';

/**
 * API endpoint to get the actual system timezone of the server
 * This does NOT use the database, but directly detects the system timezone
 */
export async function GET() {
  try {
    // Get system timezone directly from the utility function
    const systemTimezone = getSystemTimezone();
    
    return NextResponse.json({
      success: true,
      data: {
        systemTimezone,
        currentTime: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error in system-timezone endpoint:', error);
    return NextResponse.json({
      success: false,
      error: 'Failed to get system timezone information'
    }, { status: 500 });
  }
}
