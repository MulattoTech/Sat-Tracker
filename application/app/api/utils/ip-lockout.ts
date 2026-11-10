// In-memory store for tracking failed login attempts
// In a production environment, this should be replaced with a persistent store like Redis
interface FailedAttempt {
  count: number;
  lockoutUntil: number | null;
}

const failedAttempts: Record<string, FailedAttempt> = {};

// Maximum number of failed attempts before lockout
const MAX_ATTEMPTS = 3;
// Lockout duration in milliseconds (5 minutes)
const LOCKOUT_DURATION = 5 * 60 * 1000;

/**
 * Check if an IP is currently locked out
 * @param ip The IP address to check
 * @returns Object containing lockout status and time remaining
 */
export function checkIpLockout(ip: string): { locked: boolean; remainingTime: number } {
  const attempt = failedAttempts[ip];
  
  // If no record exists for this IP, it's not locked
  if (!attempt) {
    return { locked: false, remainingTime: 0 };
  }
  
  // If there's a lockout time and it's in the future, the IP is locked
  if (attempt.lockoutUntil && attempt.lockoutUntil > Date.now()) {
    return { 
      locked: true, 
      remainingTime: attempt.lockoutUntil - Date.now() 
    };
  }
  
  // If the lockout time has passed, reset the record and return not locked
  if (attempt.lockoutUntil && attempt.lockoutUntil <= Date.now()) {
    attempt.count = 0;
    attempt.lockoutUntil = null;
    return { locked: false, remainingTime: 0 };
  }
  
  // If there's no lockout time but there are failed attempts, return not locked
  return { locked: false, remainingTime: 0 };
}

/**
 * Record a failed login attempt for an IP
 * @param ip The IP address to record the failed attempt for
 * @returns Object containing lockout status and time remaining
 */
export function recordFailedAttempt(ip: string): { locked: boolean; remainingTime: number } {
  // Get or create the record for this IP
  const attempt = failedAttempts[ip] || { count: 0, lockoutUntil: null };
  
  // If the IP is already locked, return the current status
  if (attempt.lockoutUntil && attempt.lockoutUntil > Date.now()) {
    return { 
      locked: true, 
      remainingTime: attempt.lockoutUntil - Date.now() 
    };
  }
  
  // Increment the failed attempt count
  attempt.count += 1;
  
  // If the count exceeds the maximum, lock the IP
  if (attempt.count >= MAX_ATTEMPTS) {
    attempt.lockoutUntil = Date.now() + LOCKOUT_DURATION;
    attempt.count = 0; // Reset count for next window
  }
  
  // Update the record
  failedAttempts[ip] = attempt;
  
  // Return the current status
  return { 
    locked: attempt.lockoutUntil !== null && attempt.lockoutUntil > Date.now(), 
    remainingTime: attempt.lockoutUntil ? attempt.lockoutUntil - Date.now() : 0 
  };
}

/**
 * Reset failed attempts for an IP after successful login
 * @param ip The IP address to reset
 */
export function resetFailedAttempts(ip: string): void {
  if (failedAttempts[ip]) {
    failedAttempts[ip].count = 0;
    failedAttempts[ip].lockoutUntil = null;
  }
}
