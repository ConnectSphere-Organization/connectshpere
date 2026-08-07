import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const backendUrl = process.env.BACKEND_API_URL || 'http://localhost:5001';

  try {
    const response = await fetch(`${backendUrl}/api/public/service-status`, {
      cache: 'no-store',
    });

    if (!response.ok) {
      return NextResponse.json({ available: true, statusKnown: false }, { status: 200 });
    }

    return NextResponse.json(await response.json(), {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    // Do not redirect based on an unavailable status dependency. The caller
    // must distinguish this from a confirmed available state.
    return NextResponse.json({ available: true, statusKnown: false }, { status: 200 });
  }
}