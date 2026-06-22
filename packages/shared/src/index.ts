export * from "./manifest.js";
export * from "./contracts.js";

/** The wildcard the platform serves apps under is configured server-side;
 *  this is only the shape the CLI uses when composing URLs locally. */
export function appUrl(appsDomain: string, subdomain: string): string {
  return `https://${subdomain}.${appsDomain}`;
}
