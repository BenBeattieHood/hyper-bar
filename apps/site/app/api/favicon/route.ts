import { NextRequest, NextResponse } from 'next/server';

const colours = ['#c9513b', '#22776c', '#3c6e9f', '#8d5e3d', '#a34161', '#697538'];

export async function GET(request: NextRequest) {
  const pageUrl = request.nextUrl.searchParams.get('pageUrl') ?? 'https://hyper.local';
  let hostname = 'Hyper';
  let colourIndex = 0;

  try {
    const url = new URL(pageUrl);
    hostname = url.hostname;
    colourIndex = [...hostname].reduce((sum, character) => sum + character.charCodeAt(0), 0) % colours.length;
  } catch {
    // Keep deterministic fallback artwork for malformed sample URLs.
  }

  const initial = hostname.slice(0, 1).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${colours[colourIndex]}"/><text x="16" y="20" text-anchor="middle" font-family="system-ui" font-size="13" font-weight="700" fill="white">${initial}</text></svg>`;

  return new NextResponse(svg, {
    headers: {
      'Cache-Control': 'public, max-age=86400, immutable',
      'Content-Type': 'image/svg+xml; charset=utf-8',
    },
  });
}
