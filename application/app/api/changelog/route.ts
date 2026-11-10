import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

/**
 * GET handler for the changelog API endpoint
 * Reads the CHANGELOG.MD file and returns its contents
 */
export async function GET() {
  try {
    // Get the absolute path to the CHANGELOG.MD file
    const changelogPath = path.join(process.cwd(), 'CHANGELOG.md');
    
    // Check if the file exists
    if (!fs.existsSync(changelogPath)) {
      return NextResponse.json(
        { error: 'Changelog file not found' },
        { status: 404 }
      );
    }
    
    // Read the file contents
    const changelogContent = fs.readFileSync(changelogPath, 'utf8');
    
    // Return the content
    return NextResponse.json({ content: changelogContent });
  } catch (error) {
    console.error('Error reading changelog:', error);
    return NextResponse.json(
      { error: 'Failed to read changelog' },
      { status: 500 }
    );
  }
}
