import { useEffect } from "react";
import { useLocation } from "react-router-dom";

import { trackPageview } from "@/lib/analytics";
import { startLocalAnalyticsCapture, trackLocalPageview } from "@/lib/local-analytics";

// Observe SPA route changes and report page views; trackPageview is a no-op when analytics is not configured.
export function AnalyticsTracker() {
    const location = useLocation();

    useEffect(() => {
        trackPageview(`${location.pathname}${location.search}`);
    }, [location.pathname, location.search]);

    useEffect(() => {
        trackLocalPageview(location.pathname);
    }, [location.pathname]);

    useEffect(() => {
        startLocalAnalyticsCapture();
    }, []);

    return null;
}
