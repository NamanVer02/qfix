import { NextRequest, NextResponse } from "next/server";
import { checkServerConversionLimit } from "@/lib/serverRateLimit";

export const runtime = "nodejs";

/**
 * API endpoint to check conversion limit for a logged-in user.
 * Uses server-side Firebase Admin so limit detection matches enforcement (tailor API).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { userId, action } = body;

    if (!userId) {
      return NextResponse.json(
        { error: "User ID is required." },
        { status: 400 }
      );
    }

    if (action === "check") {
      const limitCheck = await checkServerConversionLimit(userId);
      const remaining = limitCheck.remaining ?? 0;
      return NextResponse.json({
        remaining,
        isSpecial: remaining === -1,
      });
    }

    if (action === "record") {
      // Conversion is recorded atomically by the tailor API via checkAndReserveConversion
      return NextResponse.json({
        message: "Conversions are recorded by the tailor API.",
      });
    }

    return NextResponse.json(
      { error: "Invalid action." },
      { status: 400 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isCredentialsError =
      /default credentials|credentials|FIREBASE_SERVICE_ACCOUNT|GOOGLE_APPLICATION_CREDENTIALS/i.test(
        message
      );

    if (isCredentialsError) {
      console.warn(
        "Rate limit check skipped: Firebase Admin credentials not set. Set FIREBASE_SERVICE_ACCOUNT (service account JSON string) for server-side limit enforcement. See https://firebase.google.com/docs/admin/setup."
      );
      // Return 200 with 1 remaining so the UI doesn't break; tailor API will still require credentials
      return NextResponse.json({ remaining: 1, isSpecial: false });
    }

    console.error("Error in rate limit API:", error);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}
