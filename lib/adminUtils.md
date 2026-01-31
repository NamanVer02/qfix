# Admin Utilities

## Marking Users as Special (Unlimited Conversions)

To mark a user as "special" (unlimited conversions), you need to update their document in Firestore:

### Using Firebase Console:

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Navigate to Firestore Database
3. Find or create a document in the `users` collection with the user's UID
4. Add/update the field: `isSpecial: true`

### Using Firebase CLI:

```bash
firebase firestore:set users/{USER_ID} '{"isSpecial": true}'
```

### Using JavaScript/TypeScript (Admin SDK):

```typescript
import { getFirestore } from "firebase-admin/firestore";

const db = getFirestore();
await db.collection("users").doc(userId).set({
  isSpecial: true
}, { merge: true });
```

### Firestore Structure:

```
users/
  {userId}/
    isSpecial: boolean (default: false)
    lastConversionDate: string (YYYY-MM-DD format)
    conversionsToday: number
    lastConversion: timestamp
    updatedAt: timestamp
```

## Rate Limiting Rules:

- **Regular Users**: 1 conversion per calendar day (UTC). If the last conversion was today (UTC), the next allowed conversion is tomorrow (midnight UTC).
- **Special Users**: Unlimited conversions (isSpecial: true)
