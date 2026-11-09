/**
 * tempo: "Load full file": a full read (`ProjectReadFileInput.full`) returns the whole file up to this
 * cap; a larger file stays a first-MiB preview. The read is one WebSocket message; the client drops
 * a socket silent for 15 seconds (`PING_TIMEOUT`) and the read starts over, so the cap keeps even
 * incompressible text under 7 seconds at 10 Mbps.
 */
export const TEMPO_FULL_FILE_READ_MAX_BYTES = 8 * 1024 * 1024;
