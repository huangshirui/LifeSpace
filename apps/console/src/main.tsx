import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ControlPlaneApp from "./ControlPlaneApp";
import ApplicationConfigurationOverlay from "./ApplicationConfigurationOverlay";
import CredentialGovernanceOverlay from "./CredentialGovernanceOverlay";
import ExternalConnectionsOverlay from "./ExternalConnectionsOverlay";
import ExternalBindingManagerOverlay from "./ExternalBindingManagerOverlay";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("LifeSpace Console root element is missing");

createRoot(root).render(
  <StrictMode>
    <ControlPlaneApp />
    <ApplicationConfigurationOverlay />
    <CredentialGovernanceOverlay />
    <ExternalConnectionsOverlay />
    <ExternalBindingManagerOverlay />
  </StrictMode>,
);
