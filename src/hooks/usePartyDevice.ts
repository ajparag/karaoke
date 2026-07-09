// =============================================================================
// CHANGELOG
// v1 -- NEW. Generates and persists a random per-browser device ID, used to
//   let a participant identify "which queue entries are mine" so the UI can
//   show a Remove button only on their own additions (host sees Remove on
//   everything). Also persists the guest display name entered at join time,
//   scoped per-party (a person might join different parties with different
//   names, or the same name across all -- storing per-code keeps it simple
//   without forcing a global identity).
// =============================================================================

const DEVICE_ID_KEY = 'karaokeparty_device_id';

export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function getGuestName(code: string): string | null {
  return sessionStorage.getItem(`party_guest_name_${code}`);
}

export function setGuestName(code: string, name: string): void {
  sessionStorage.setItem(`party_guest_name_${code}`, name);
}
