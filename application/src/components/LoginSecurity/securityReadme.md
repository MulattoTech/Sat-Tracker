# Security Component Documentation

## Overview

The Security component provides authentication functionality for the Baby Tracker application. It implements a two-factor authentication system requiring users to enter both a login ID and a security PIN to access the application, with JWT token-based authentication.

## Features

- Two-step authentication with login ID and security PIN
- JWT token-based authentication with 8-hour token lifetime
- Automatic session timeout after 30 minutes of inactivity
- Lockout mechanism after 3 failed authentication attempts
- Session persistence using localStorage and JWT tokens
- User activity monitoring to reset timeout timer
- Token invalidation on logout

## Props

| Prop Name | Type | Description |
|-----------|------|-------------|
| onUnlock | `(caretakerId?: string) => void` | Callback function executed when authentication is successful. Returns the authenticated caretaker's ID. |

## Authentication Flow

1. User enters their 2-character login ID
2. Upon valid login ID entry, user is prompted for their security PIN
3. System validates the credentials against the caretaker database
4. If valid, the user is granted access and the caretaker ID is stored in localStorage
5. If invalid, the user is shown an error message and allowed to retry (up to 3 attempts)

## Security Features

### Session Management

- JWT tokens have an 8-hour lifetime for extended user sessions
- Sessions automatically expire after 30 minutes of inactivity
- User activity (mouse movement, clicks, keyboard input) resets the inactivity timer
- When a session expires, the user must re-authenticate
- Tokens are invalidated server-side during logout or session expiration

### Lockout Protection

- After 3 failed authentication attempts, the system implements a 5-minute lockout that is IP based
- During lockout, authentication attempts are disabled
- A countdown timer shows the remaining lockout time

### Data Storage

- Authentication state is stored in localStorage:
  - `authToken`: JWT token containing user information and expiration
  - `unlockTime`: Timestamp of successful authentication
  - `caretakerId`: ID of the authenticated caretaker (for backward compatibility)
  - `attempts`: Number of failed authentication attempts
  - `lockoutTime`: Timestamp when lockout period ends (if applicable)

## API Integration

The Security component interacts with two main endpoints:

### Authentication (`/api/auth`)
1. Accepts login ID and security PIN
2. Validates credentials against the caretaker database
3. Issues a JWT token with an 8-hour expiration
4. Returns caretaker information and token upon successful authentication
5. Returns appropriate error messages on authentication failure

### Logout (`/api/auth/logout`)
1. Invalidates the current JWT token by adding it to a blacklist
2. Clears authentication cookies
3. Used during manual logout and automatic session expiration

## Usage Example

```tsx
import Security from '@/src/components/Security';

function App() {
  const handleUnlock = (caretakerId?: string) => {
    console.log(`Authenticated as caretaker: ${caretakerId}`);
    // Perform post-authentication actions
  };

  return (
    <div>
      <Security onUnlock={handleUnlock} />
      {/* Rest of your application */}
    </div>
  );
}
```

## Customization

The Security component can be customized by modifying:

- JWT token lifetime (currently set to 8 hours)
- Inactivity timeout duration (currently set to 30 minutes)
- Lockout duration (currently set to 5 minutes)
- Number of allowed failed attempts before lockout (currently set to 3)
- Visual appearance of the login and PIN input screens

## Development Tools

In development mode, a Debug Session Timer component is available that displays:
- JWT token expiration countdown
- User idle time
- The timer is draggable and can be positioned anywhere on screen
- It can be closed if not needed
