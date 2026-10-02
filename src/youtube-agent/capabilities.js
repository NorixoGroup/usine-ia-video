// Classes de capacité. Chaque moteur déclare celles qu'il utilise ; les classes
// externes exigent une approbation humaine liée à l'action.

export const CAPABILITIES = Object.freeze({
  local_read: Object.freeze({ approval_required: false, executable_in_r18_2: true }),
  local_write: Object.freeze({ approval_required: false, executable_in_r18_2: false }),
  external_read: Object.freeze({ approval_required: true, executable_in_r18_2: false }),
  external_paid: Object.freeze({ approval_required: true, executable_in_r18_2: false }),
  external_write: Object.freeze({ approval_required: true, executable_in_r18_2: false })
});

export function isCapability(name) {
  return Object.hasOwn(CAPABILITIES, name);
}

export function requiresApproval(capability) {
  if (!isCapability(capability)) throw new Error(`Capacité inconnue : ${capability}`);

  return CAPABILITIES[capability].approval_required;
}

// Une liste de capacités est exécutable en R18.2 seulement si toutes le sont.
export function isExecutableInR182(capabilities) {
  return capabilities.length > 0 && capabilities.every(c => isCapability(c) && CAPABILITIES[c].executable_in_r18_2);
}
