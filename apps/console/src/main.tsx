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
  if (!/^\/spaces\/spc_[A-Za-z0-9_-]+\/?$/u.test(routeKey)) return null;
  return <div className="space-config-launcher" aria-label="Space configuration">
    <span className="cp-launcher-label">Space</span>
    <SpaceGrantGovernanceOverlay />
    <ExternalConnectionsOverlay key={routeKey} />
  </div>;
}

const root = document.getElementById("root");
if (!root) throw new Error("LifeSpace Console root element is missing");

createRoot(root).render(
  <StrictMode>
    <ControlPlaneApp extraActions={<>
      <ApplicationConfigurationOverlay />
      <CredentialGovernanceOverlay />
      <RouteAwareSpaceConfigurationOverlays />
    </>} />
  </StrictMode>,
);
