/**
 * Google Meet & Google Calendar API Integration Service
 * Uses Google OAuth 2.0 Refresh Token to create authentic Google Meet conference links.
 */

let cachedToken = null;
let tokenExpiry = 0;

/**
 * Retrieves valid Google OAuth Access Token
 */
export async function getGoogleAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry - 60000) {
    return cachedToken;
  }

  // Support all common variable name variations that might be in Railway
  const clientId = process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_MEET_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_SECRET_ID || process.env.GOOGLE_SECRET || process.env.GOOGLE_MEET_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN || process.env.GOOGLE_MEET_REFRESH_TOKEN || process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    console.warn("[Google Meet API] Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REFRESH_TOKEN in env.");
    return null;
  }

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token"
      })
    });

    const data = await res.json();
    if (data.access_token) {
      cachedToken = data.access_token;
      tokenExpiry = now + (data.expires_in || 3600) * 1000;
      return cachedToken;
    } else {
      console.error("[Google Meet API] Token error:", data);
      return null;
    }
  } catch (err) {
    console.error("[Google Meet API] Failed to fetch access token:", err.message);
    return null;
  }
}

/**
 * Creates an authentic Google Meet room via Google Calendar API
 */
export async function createGoogleMeetEvent({ topic, startTime, durationMinutes = 45, leadEmail }) {
  const token = await getGoogleAccessToken();
  
  if (!token) {
    console.warn("[Google Meet API] No valid token, generating clean fallback Google Meet format or URL");
    // Fallback: Return standard format if credentials in Railway need attention
    return null;
  }

  try {
    const start = startTime ? new Date(startTime) : new Date(Date.now() + 15 * 60 * 1000);
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

    const eventPayload = {
      summary: topic || "Salon Nest Product Demo",
      description: `Product Demonstration Meeting with ${leadEmail || "Client"}`,
      start: {
        dateTime: start.toISOString(),
        timeZone: "Asia/Kolkata"
      },
      end: {
        dateTime: end.toISOString(),
        timeZone: "Asia/Kolkata"
      },
      attendees: leadEmail ? [{ email: leadEmail }] : [],
      conferenceData: {
        createRequest: {
          requestId: `sn-meet-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          conferenceSolutionKey: {
            type: "hangoutsMeet"
          }
        }
      }
    };

    const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || "primary");
    const calendarUrl = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?conferenceDataVersion=1`;

    const res = await fetch(calendarUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(eventPayload)
    });

    const data = await res.json();
    
    // Check hangoutLink or conferenceData
    const meetUrl = data.hangoutLink || data.conferenceData?.entryPoints?.find(e => e.entryPointType === "video")?.uri;
    
    if (meetUrl) {
      console.log(`[Google Meet API] Successfully created real meeting: ${meetUrl}`);
      return {
        meetingUrl: meetUrl,
        eventId: data.id,
        isRealApi: true
      };
    } else {
      console.warn("[Google Meet API] Event created without conference link:", data);
      return null;
    }
  } catch (err) {
    console.error("[Google Meet API] Event creation failed:", err.message);
    return null;
  }
}
