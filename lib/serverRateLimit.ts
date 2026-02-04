import { initializeApp, getApps, cert, App } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";

let app: App | undefined;
let db: Firestore | undefined;

/**
 * Initialize Firebase Admin SDK
 * 
 * Setup options:
 * 1. Set FIREBASE_SERVICE_ACCOUNT environment variable with service account JSON string
 * 2. Set GOOGLE_APPLICATION_CREDENTIALS to path of service account JSON file (local only)
 * 3. Use Application Default Credentials (gcloud CLI for local, or GCP service account for production)
 * 4. Set NEXT_PUBLIC_FIREBASE_PROJECT_ID and use projectId initialization (limited functionality)
 */
function getAdminFirestore(): Firestore {
  if (db) {
    return db;
  }

  // Check if already initialized
  if (getApps().length === 0) {
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
    const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    
    if (serviceAccount) {
      // Parse service account from environment variable (JSON string)
      try {
        // Trim whitespace and remove surrounding quotes if present (common in Vercel env vars)
        let cleaned = serviceAccount.trim();
        // Remove surrounding single or double quotes if the entire string is quoted
        if (
          (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
          (cleaned.startsWith("'") && cleaned.endsWith("'"))
        ) {
          cleaned = cleaned.slice(1, -1);
        }
        // Unescape quotes that might have been escaped
        cleaned = cleaned.replace(/\\"/g, '"').replace(/\\'/g, "'");
        
        const serviceAccountJson = JSON.parse(cleaned) as Record<string, unknown>;
        // Env vars often store private_key with literal \n; cert() needs real newlines
        if (typeof serviceAccountJson.private_key === "string") {
          serviceAccountJson.private_key = serviceAccountJson.private_key.replace(/\\n/g, "\n");
        }
        app = initializeApp({
          credential: cert(serviceAccountJson as Parameters<typeof cert>[0]),
          projectId: (serviceAccountJson.project_id as string) || projectId,
        });
      } catch (error) {
        console.error("Error parsing FIREBASE_SERVICE_ACCOUNT:", error);
        throw new Error("Failed to initialize Firebase Admin: Invalid service account JSON");
      }
    } else if (projectId) {
      // Fallback: initialize with project ID only (requires Application Default Credentials)
      // This works in GCP environments or with gcloud CLI configured locally
      try {
        app = initializeApp({
          projectId: projectId,
        });
      } catch (error) {
        console.error("Error initializing Firebase Admin with projectId:", error);
        throw new Error("Failed to initialize Firebase Admin. Please set FIREBASE_SERVICE_ACCOUNT environment variable.");
      }
    } else {
      throw new Error("Firebase Admin initialization failed: Missing FIREBASE_SERVICE_ACCOUNT or NEXT_PUBLIC_FIREBASE_PROJECT_ID");
    }
  } else {
    app = getApps()[0];
  }

  db = getFirestore(app);
  return db;
}

/** Current calendar date in UTC (YYYY-MM-DD). Daily limit resets at midnight UTC; next conversion allowed tomorrow. */
function getTodayUTC(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Server-side check and reserve a conversion slot atomically
 * This prevents race conditions where multiple requests pass the check simultaneously
 * Daily limit: 1 conversion per calendar day (UTC). If last conversion was today, next allowed is tomorrow.
 */
export async function checkAndReserveConversion(
  userId: string
): Promise<{ allowed: boolean; reason?: string; remaining?: number }> {
  const firestore = getAdminFirestore();
  const userDocRef = firestore.collection("users").doc(userId);
  const today = getTodayUTC();

  const result = await firestore.runTransaction(async (transaction) => {
    const userDoc = await transaction.get(userDocRef);

    // Check if user is special (unlimited)
    if (userDoc.exists) {
      const userData = userDoc.data();
      if (userData?.isSpecial === true) {
        return { allowed: true, remaining: -1, shouldRecord: false };
      }
    }

    const userData = userDoc.exists ? userDoc.data() : null;
    const lastConversionDate = (userData?.lastConversionDate as string | undefined) ?? null;
    const conversionsToday = Number(userData?.conversionsToday ?? 0);

    // Same calendar day (UTC): if already used the daily slot, deny until tomorrow
    if (lastConversionDate === today) {
      if (conversionsToday >= 1) {
        return {
          allowed: false,
          reason: "You have reached your daily limit of 1 conversion. Please try again tomorrow.",
          remaining: 0,
          shouldRecord: false,
        };
      }
      transaction.update(userDocRef, {
        conversionsToday: conversionsToday + 1,
        lastConversion: new Date(),
      });
      return { allowed: true, remaining: 0, shouldRecord: false };
    }

    // New day or first conversion: reserve the slot (next allowed after this is tomorrow)
    transaction.set(
      userDocRef,
      {
        lastConversionDate: today,
        conversionsToday: 1,
        lastConversion: new Date(),
        updatedAt: new Date(),
      },
      { merge: true }
    );
    return { allowed: true, remaining: 0, shouldRecord: false };
  });

  return {
    allowed: result.allowed,
    reason: result.reason,
    remaining: result.remaining,
  };
}

/**
 * Server-side check if user can make a conversion (read-only, for status checks).
 * Daily limit: 1 per calendar day (UTC). If last conversion was today, next allowed is tomorrow.
 */
export async function checkServerConversionLimit(
  userId: string
): Promise<{ allowed: boolean; reason?: string; remaining?: number }> {
  const firestore = getAdminFirestore();
  const userDocRef = firestore.collection("users").doc(userId);
  const userDoc = await userDocRef.get();

  // No document = new user, 1 conversion allowed today
  if (!userDoc.exists) {
    return { allowed: true, remaining: 1 };
  }

  const userData = userDoc.data();
  if (userData?.isSpecial === true) {
    return { allowed: true, remaining: -1 };
  }

  const today = getTodayUTC();
  const lastConversionDate = (userData?.lastConversionDate as string | undefined) ?? null;
  const conversionsToday = Number(userData?.conversionsToday ?? 0);

  // Same day (UTC): already used today => 0 remaining until tomorrow
  if (lastConversionDate === today) {
    if (conversionsToday >= 1) {
      return {
        allowed: false,
        reason: "You have reached your daily limit of 1 conversion. Please try again tomorrow.",
        remaining: 0,
      };
    }
    return { allowed: true, remaining: 1 - conversionsToday };
  }

  // Different day or first conversion => 1 remaining today
  return { allowed: true, remaining: 1 };
}

/**
 * Server-side record a conversion for a user (atomic operation).
 * Date is stored as UTC calendar day; next conversion allowed tomorrow.
 */
export async function recordServerConversion(userId: string): Promise<void> {
  const firestore = getAdminFirestore();
  const userDocRef = firestore.collection("users").doc(userId);
  const today = getTodayUTC();

  await firestore.runTransaction(async (transaction) => {
    const userDoc = await transaction.get(userDocRef);
    const userData = userDoc.exists ? userDoc.data() : null;
    const lastConversionDate = (userData?.lastConversionDate as string | undefined) ?? null;
    const conversionsToday = Number(userData?.conversionsToday ?? 0);

    if (lastConversionDate === today) {
      transaction.update(userDocRef, {
        conversionsToday: conversionsToday + 1,
        lastConversion: new Date(),
      });
    } else {
      transaction.set(
        userDocRef,
        {
          lastConversionDate: today,
          conversionsToday: 1,
          lastConversion: new Date(),
          updatedAt: new Date(),
        },
        { merge: true }
      );
    }
  });
}
