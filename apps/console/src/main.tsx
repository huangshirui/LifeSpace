import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import ControlPlaneApp from "./ControlPlaneApp";
import ApplicationConfigurationOverlay from "./ApplicationConfigurationOverlay";
import CredentialGovernanceOverlay from "./CredentialGovernanceOverlay";
import ExternalConnectionsOverlay from "./ExternalConnectionsOverlay";
import SpaceGrantGovernanceOverlay from "./SpaceGrantGovernanceOverlay";
import "./styles.css";
import "./space-configuration-launcher.css";

function RouteAwareSpaceConfigurationOverlays() {
  const [routeKey, setRouteKey] = useState(() => window.location.pathname);
  useEffect(() => {
    const update = () => setRouteKey(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return <div className="space-config-launcher" aria-label="Space configuration">
    <SpaceGrantGovernanceOverlay />
    <ExternalConnectionsOverlay key={routeKey} />
  </div>;
}

const root = document.getElementById("root");
if (!root) throw new Error("LifeSpace Console root element is missing");

createRoot(root).render(
  <StrictMode>
    <ControlPlaneApp />
    <ApplicationConfigurationOverlay />
    <CredentialGovernanceOverlay />
    <RouteAwareSpaceConfigurationOverlays />
  </StrictMode>,
);
