import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { clearJwt, getInterviewer, isJwtExpired } from '../../api/client';
import { useState } from 'react';

const REFRESH_INTERVAL_MS = 30_000;

export function AuthGuard() {
  const location = useLocation();
  const [, force] = useState(0);

  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), REFRESH_INTERVAL_MS);
    return () => clearInterval(t);
  }, []);

  if (isJwtExpired()) {
    clearJwt();
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  const interviewer = getInterviewer();
  if (!interviewer) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet context={interviewer} />;
}
