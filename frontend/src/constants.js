export const SPARKPLUG_TYPES = {
  1: 'Int8', 2: 'Int16', 3: 'Int32', 4: 'Int64',
  5: 'UInt8', 6: 'UInt16', 7: 'UInt32', 8: 'UInt64',
  9: 'Float', 10: 'Double', 11: 'Boolean', 12: 'String',
  13: 'DateTime', 14: 'Text',
};

export const PERMISSION_UUIDS = {
  QUARANTINE_VIEW:    'cb46a943-42e1-4c1d-8706-933e08544e30',
  QUARANTINE_APPROVE: 'cb46a943-42e1-4c1d-8706-933e08544e31',
  QUARANTINE_REJECT:  'a123b456-7890-4c1d-8706-933e08544e32',
  DEVICE_MANAGE:      'd987c654-3210-4c1d-8706-933e08544e33',
  CELL_MANAGE:        'c456d789-0123-4c1d-8706-933e08544e34',
  GATEWAY_MANAGE:     'e789a012-3456-4c1d-8706-933e08544e35',
  TELEMETRY_READ:     'f012a345-6789-4c1d-8706-933e08544e36',
  ARCHIVE_MANAGE:     'b345c678-9012-4c1d-8706-933e08544e37',
  DOCUMENT_MANAGE:    'a012b345-6789-4c1d-8706-933e08544e38',
  AUTHZ_MANAGE:       'e012c345-6789-4c1d-8706-933e08544e39',
  SCHEMA_MANAGE:      'f123d456-7890-4c1d-8706-933e08544e40',
  GITOPS_MANAGE:      'c234e567-8901-4c1d-8706-933e08544e41',
};

export const oidcConfig = {
  authority: import.meta.env.VITE_KEYCLOAK_AUTHORITY || "http://localhost:8084/realms/factoryplus",
  client_id: import.meta.env.VITE_KEYCLOAK_CLIENT_ID || "factoryplus-dashboard",
  redirect_uri: typeof window !== 'undefined' ? window.location.origin + "/" : "/",
  onSigninCallback: () => {
    if (typeof window !== 'undefined') {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }
};

export const VALID_TABS = [
  'overview', 'cells', 'gateways', 'devices', 'digital-thread', 'telemetry', 'schemas', 'directory', 'archives'
];

export const PERSONAS = [
  { id: 'admin@factoryplus.local',    label: 'Administrator (Full Access)' },
  { id: 'manager@factoryplus.local',  label: 'Shopfloor Manager (Ops & Approval)' },
  { id: 'operator@factoryplus.local', label: 'Operator (Read-Only View)' },
  { id: 'auditor@factoryplus.local',  label: 'Auditor (Digital Thread Trace)' },
];
