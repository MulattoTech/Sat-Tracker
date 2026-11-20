'use client';

import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { useDeployment } from '../../app/context/deployment';
import { loadFamilyBySlugWithRetry } from '@/src/utils/session-timeout';
import { createAuthFetchInterceptor } from '@/src/utils/session-fetch';

interface Family {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
}

interface FamilyContextType {
  family: Family | null;
  loading: boolean;
  error: string | null;
  setFamily: (family: Family) => void;
  families: Family[];
  loadFamilies: () => Promise<void>;
  handleLogout?: (reason?: string) => void;
  authenticatedFetch: (url: string, options?: RequestInit) => Promise<Response>;
}

const FamilyContext = createContext<FamilyContextType | undefined>(undefined);

export function FamilyProvider({ children, onLogout }: { children: ReactNode; onLogout?: (reason?: string) => void }) {
  const [family, setFamily] = useState<Family | null>(() => {
    // Try to get from localStorage first for persistence
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('selectedFamily');
      return saved ? JSON.parse(saved) : null;
    }
    return null;
  });
  const [families, setFamilies] = useState<Family[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pathname = usePathname();
  const { isSaasMode } = useDeployment();

  // Extract family slug from URL
  const getFamilySlugFromUrl = () => {
    if (!pathname) return null;
    const segments = pathname.split('/').filter(Boolean);
    return segments.length > 0 ? segments[0] : null;
  };

  // Persist selected family
  useEffect(() => {
    if (family) {
      localStorage.setItem('selectedFamily', JSON.stringify(family));
    }
  }, [family]);

  // Load family data based on slug in URL or system admin context
  useEffect(() => {
    const loadFamilyFromUrl = async () => {
      const slug = getFamilySlugFromUrl();
      if (!slug) {
        setLoading(false);
        return;
      }

      try {
        // Check if user is a system administrator
        const authToken = localStorage.getItem('authToken');
        let isSysAdmin = false;
        
        if (authToken) {
          try {
            const payload = authToken.split('.')[1];
            const decodedPayload = JSON.parse(atob(payload));
            isSysAdmin = decodedPayload.isSysAdmin || false;
          } catch (error) {
            console.error('Error parsing JWT token in family context:', error);
          }
        }

        // For system administrators, we need to load family by slug since they don't have a fixed familyId
        // For regular users, this also works as expected
        const { outcome, data } = await loadFamilyBySlugWithRetry(slug, { authToken });

        if (outcome === 'valid' && data) {
          setFamily(data);

          // For system administrators, store the family context so APIs can use it
          if (isSysAdmin && typeof window !== 'undefined') {
            sessionStorage.setItem('sysadmin-family-context', JSON.stringify(data));
          }
        } else if (outcome === 'not-found') {
          // Definitive: the slug does not resolve to a family.
          setError('Failed to load family data');
        }
        // 'transient': keep the last-known family (initialized from
        // localStorage) rather than nulling it — a resumed PWA whose family
        // fetch blips must not be treated as "family gone" (issue #209).
      } catch (err) {
        // Only set error for unexpected errors, not for network/fetch failures
        if (err instanceof Error && err.name !== 'TypeError') {
          setError(err.message);
        }
        // For fetch errors, just stop loading silently
      } finally {
        setLoading(false);
      }
    };

    loadFamilyFromUrl();
  }, [pathname]);

  // Load all available families
  const loadFamilies = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/family/list');
      if (!response.ok) {
        throw new Error('Failed to load families');
      }

      const data = await response.json();
      if (data.success && data.data) {
        setFamilies(data.data);
      } else {
        setError(data.error || 'Failed to load families');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  // Function to check if account has expired in SAAS mode (checks JWT token in memory)
  const checkAccountExpiration = useCallback(() => {
    // Only check if we have a family and are in client environment
    if (typeof window === 'undefined' || !family?.slug) return;

    try {
      const authToken = localStorage.getItem('authToken');
      if (!authToken) return;

      // Only check expiration in SAAS mode
      if (!isSaasMode) return;

      // Decode JWT token to get account info
      let decodedPayload;
      try {
        const payload = authToken.split('.')[1];
        decodedPayload = JSON.parse(atob(payload));
      } catch (error) {
        console.error('Error parsing JWT token for expiration check:', error);
        return;
      }

      // Only check expiration for account-based auth
      if (!decodedPayload.isAccountAuth) return;

      // Skip check for beta participants (from JWT token)
      if (decodedPayload.betaparticipant) return;

      // Check if account/trial is expired based on JWT token data
      const now = new Date();
      let isExpired = false;

      if (decodedPayload.trialEnds) {
        const trialEndDate = new Date(decodedPayload.trialEnds);
        isExpired = now > trialEndDate;
      } else if (decodedPayload.planExpires) {
        const planEndDate = new Date(decodedPayload.planExpires);
        isExpired = now > planEndDate;
      } else if (!decodedPayload.planType && !decodedPayload.betaparticipant) {
        // No trial, no plan, and not beta - expired
        isExpired = true;
      }

      if (isExpired) {
        console.log('Account expired (from JWT token) - soft expiration: user remains logged in with read-only access');
        // SOFT EXPIRATION: Do NOT log out expired accounts
        // They should remain logged in with read-only access
        // The backend will block write operations via writeProtection middleware
        // The UI will show expiration banners and upgrade prompts
      }
    } catch (error) {
      console.error('Error checking account expiration:', error);
    }
  }, [family?.slug, onLogout, isSaasMode]);

  // Set up periodic account expiration checking
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Initial check
    checkAccountExpiration();

    // Check every 30 seconds
    const expirationCheckInterval = setInterval(checkAccountExpiration, 30000);

    return () => {
      clearInterval(expirationCheckInterval);
    };
  }, [checkAccountExpiration]);

  // Set up global fetch interceptor to add Authorization header and handle 401
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const originalFetch = window.fetch;
    const interceptor = createAuthFetchInterceptor({ fetchFn: originalFetch, onLogout });
    window.fetch = interceptor.fetch;
    return () => {
      interceptor.dispose();
      if (window.fetch === interceptor.fetch) window.fetch = originalFetch;
    };
  }, [onLogout]);

  // Authenticated fetch wrapper that automatically handles 401 responses
  const authenticatedFetch = useCallback(async (url: string, options?: RequestInit): Promise<Response> => {
    // Get auth token from localStorage
    const authToken = typeof window !== 'undefined' ? localStorage.getItem('authToken') : null;

    // Merge authorization header with provided options
    const headers = new Headers(options?.headers || {});
    if (authToken && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${authToken}`);
    }

    const mergedOptions: RequestInit = {
      ...options,
      headers,
    };

    try {
      // This goes through the intercepted window.fetch above, which handles
      // 401s (refresh-and-retry, then logout only if the refresh fails).
      // Handling 401 here as well would double-trigger logout.
      const response = await fetch(url, mergedOptions);

      return response;
    } catch (error) {
      console.error('API request failed:', error);
      throw error;
    }
  }, []);

  const value = {
    family,
    loading,
    error,
    setFamily,
    families,
    loadFamilies,
    handleLogout: onLogout,
    authenticatedFetch,
  };

  return <FamilyContext.Provider value={value}>{children}</FamilyContext.Provider>;
}

export function useFamily() {
  const context = useContext(FamilyContext);
  if (context === undefined) {
    throw new Error('useFamily must be used within a FamilyProvider');
  }
  return context;
}
