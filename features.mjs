// A single switch for the build, server and container entrypoint. Only the explicit value 1 enables sync.
export const familySyncEnabled = (env = process.env) => env.MINITANDEM_FAMILY_SYNC === '1';
