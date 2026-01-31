import { 
  doc, 
  getDoc, 
  setDoc, 
  updateDoc, 
  serverTimestamp
} from "firebase/firestore";
import { db } from "./firebase";

export interface UserLimits {
  isSpecial: boolean;
  lastConversionDate: string | null;
  conversionsToday: number;
}

/**
 * Check if user can make a conversion
 * Returns { allowed: boolean, reason?: string, remaining?: number }
 */
export async function checkConversionLimit(
  userId: string
): Promise<{ allowed: boolean; reason?: string; remaining?: number }> {
  try {
    const userDocRef = doc(db, "users", userId);
    const userDoc = await getDoc(userDocRef);

    // Check if user is special (unlimited)
    if (userDoc.exists()) {
      const userData = userDoc.data();
      if (userData.isSpecial === true) {
        return { allowed: true, remaining: -1 }; // -1 means unlimited
      }
    }

    // Regular user: check daily limit
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD format
    const userData = userDoc.exists() ? userDoc.data() : null;
    const lastConversionDate = userData?.lastConversionDate || null;
    const conversionsToday = userData?.conversionsToday || 0;

    // If last conversion was today, check count
    if (lastConversionDate === today) {
      if (conversionsToday >= 1) {
        return {
          allowed: false,
          reason: "You have reached your daily limit of 1 conversion. Please try again tomorrow.",
          remaining: 0,
        };
      }
      return {
        allowed: true,
        remaining: 1 - conversionsToday,
      };
    }

    // New day or first conversion
    return {
      allowed: true,
      remaining: 1,
    };
  } catch (error) {
    console.error("Error checking conversion limit:", error);
    // On error, allow the conversion (fail open)
    return { allowed: true, remaining: 1 };
  }
}

/**
 * Record a conversion for a user
 */
export async function recordConversion(userId: string): Promise<void> {
  try {
    const userDocRef = doc(db, "users", userId);
    const userDoc = await getDoc(userDocRef);

    const today = new Date().toISOString().split("T")[0];
    const userData = userDoc.exists() ? userDoc.data() : null;
    const lastConversionDate = userData?.lastConversionDate || null;
    const conversionsToday = userData?.conversionsToday || 0;

    if (lastConversionDate === today) {
      // Same day: increment count
      await updateDoc(userDocRef, {
        conversionsToday: conversionsToday + 1,
        lastConversion: serverTimestamp(),
      });
    } else {
      // New day: reset count
      await setDoc(
        userDocRef,
        {
          lastConversionDate: today,
          conversionsToday: 1,
          lastConversion: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }
  } catch (error) {
    console.error("Error recording conversion:", error);
    // Don't throw - conversion should still succeed even if tracking fails
  }
}

/**
 * Get user's current limit status
 */
export async function getUserLimitStatus(
  userId: string
): Promise<UserLimits & { remaining: number }> {
  try {
    const userDocRef = doc(db, "users", userId);
    const userDoc = await getDoc(userDocRef);

    if (!userDoc.exists()) {
      return {
        isSpecial: false,
        lastConversionDate: null,
        conversionsToday: 0,
        remaining: 1,
      };
    }

    const userData = userDoc.data();
    const today = new Date().toISOString().split("T")[0];
    const lastConversionDate = userData?.lastConversionDate || null;
    const conversionsToday = userData?.conversionsToday || 0;

    if (userData.isSpecial === true) {
      return {
        isSpecial: true,
        lastConversionDate: lastConversionDate,
        conversionsToday: conversionsToday,
        remaining: -1, // Unlimited
      };
    }

    // Regular user
    if (lastConversionDate === today) {
      return {
        isSpecial: false,
        lastConversionDate: lastConversionDate,
        conversionsToday: conversionsToday,
        remaining: Math.max(0, 1 - conversionsToday),
      };
    }

    return {
      isSpecial: false,
      lastConversionDate: null,
      conversionsToday: 0,
      remaining: 1,
    };
  } catch (error) {
    console.error("Error getting user limit status:", error);
    return {
      isSpecial: false,
      lastConversionDate: null,
      conversionsToday: 0,
      remaining: 1,
    };
  }
}
