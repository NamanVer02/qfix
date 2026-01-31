# Rate Limiting Setup Guide

## What Was Fixed

The rate limiting system has been **completely overhauled** to work correctly:

### Previous Issues:
1. ❌ Rate limiting was only enforced client-side (easily bypassed)
2. ❌ No server-side verification
3. ❌ Race conditions allowed multiple simultaneous conversions
4. ❌ API route didn't check limits

### Current Implementation:
1. ✅ **Server-side enforcement** - API route checks limits before processing
2. ✅ **Atomic transactions** - Prevents race conditions using Firestore transactions
3. ✅ **Double protection** - Both client and server check limits
4. ✅ **Proper error handling** - Returns 429 status when limit is reached

## How It Works Now

1. **Client-side check** (for UX) - Shows user their remaining conversions
2. **Server-side check** (for security) - API route uses Firebase Admin SDK to:
   - Check if user is special (unlimited)
   - Check daily limit atomically
   - Reserve conversion slot immediately (prevents race conditions)
   - Return 429 error if limit exceeded

## Firebase Admin SDK Setup

The server-side rate limiting requires Firebase Admin SDK. If you see **"Could not load the default credentials"**, set `FIREBASE_SERVICE_ACCOUNT` (Option 1 below); that fixes the error and enables rate limiting and tailoring.

You have two options:

### Option 1: Service Account JSON (Recommended for Production)

1. Go to [Firebase Console](https://console.firebase.google.com/) → Project Settings → Service Accounts
2. Click "Generate New Private Key"
3. Download the JSON file
4. Set environment variable `FIREBASE_SERVICE_ACCOUNT` with the JSON content as a string:

```bash
# In .env.local or Vercel environment variables
FIREBASE_SERVICE_ACCOUNT='{"type":"service_account","project_id":"...","private_key_id":"...","private_key":"...","client_email":"...","client_id":"...","auth_uri":"...","token_uri":"...","auth_provider_x509_cert_url":"...","client_x509_cert_url":"..."}'
```

### Option 2: Application Default Credentials (For Local Development)

If you have `gcloud` CLI installed and authenticated:

```bash
gcloud auth application-default login
```

Then set `NEXT_PUBLIC_FIREBASE_PROJECT_ID` in your environment.

## Environment Variables Required

Add to your `.env.local`:

```bash
# Firebase Client (already set)
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...

# Firebase Admin (NEW - for server-side rate limiting)
FIREBASE_SERVICE_ACCOUNT='{"type":"service_account",...}'  # OR use Application Default Credentials

# Existing
GEMINI_API_KEY=...
```

## Testing the Rate Limit

1. **Regular User Test:**
   - Sign in with a regular account
   - Make 1 conversion (should succeed)
   - Try to make another conversion immediately (should fail with 429 error)
   - Wait until next day (or manually reset in Firestore) to test again

2. **Special User Test:**
   - Mark a user as special in Firestore: `users/{userId}/isSpecial = true`
   - Make multiple conversions (all should succeed)

3. **Race Condition Test:**
   - Try making multiple simultaneous requests (only 1 should succeed)

## Firestore Security Rules

Make sure your Firestore rules allow the Admin SDK to read/write:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Allow authenticated users to read their own user document
    match /users/{userId} {
      allow read: if request.auth != null && request.auth.uid == userId;
      // Write is handled server-side by Admin SDK (bypasses rules)
    }
  }
}
```

## Troubleshooting

### Error: "Failed to initialize Firebase Admin"

- Make sure `FIREBASE_SERVICE_ACCOUNT` is set correctly (valid JSON string)
- Or ensure `NEXT_PUBLIC_FIREBASE_PROJECT_ID` is set and you have Application Default Credentials

### Rate limit not working

- Check browser console for errors
- Check server logs for Firebase Admin initialization errors
- Verify Firestore has the `users` collection with proper structure
- Test with a fresh user account to ensure no cached data

### Still allowing multiple conversions

- Check that the API route is being called (not bypassed)
- Verify Firebase Admin SDK is initialized correctly
- Check Firestore transactions are working (look for errors in logs)
