/**
 * Backend never echoes a stored secret: `/agent/runninghub/config` masks it with eight
 * asterisks. Writing that mask back into the field makes a freshly saved key look like it
 * was reverted, so the typed value has to survive the round trip.
 */

/** Sentinel the Backend returns for a stored secret and treats as "keep the current value". */
export const runningHubSecretMask = "********";

/**
 * Resolve the secret field value after a save response.
 *
 * The Backend preserves the stored secret when it receives the mask back, so the response
 * mask carries no new information: keep what the user actually has in the field.
 */
export function keepTypedRunningHubSecret(typed: string, fromResponse: string): string {
    if (typed !== runningHubSecretMask) return typed;
    return fromResponse === runningHubSecretMask ? typed : fromResponse;
}
