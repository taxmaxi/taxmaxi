/**
 * SourceCreationServiceLive - Live source creation application workflow.
 *
 * @module SourceCreationServiceLive
 */

import type { PrincipalId } from "@my/core/ownership";
import { parseCryptoAddress, SourceId, type ChainType } from "@my/core/source";
import {
  PrincipalClaimRepository,
  PrincipalRepository,
  SourceRepository,
} from "@my/persistence/services";
import { SourceSyncService } from "@my/sync-engine/services";
import { createHash } from "node:crypto";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Option } from "effect";
import * as Redacted from "effect/Redacted";
import * as Timestamp from "@my/core/shared/values/Timestamp";
import type { User } from "../definitions/AuthMiddleware.ts";
import {
  SourceCreationBadRequestError,
  SourceCreationInternalError,
  SourceCreationService,
  type SourceCreationServiceShape,
} from "../services/SourceCreationService.ts";

const CLI_CLAIM_TOKEN_BYTES = 32;
const CLI_CLAIM_TTL_MILLIS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_CLAIM_JURISDICTION = "germany";
const claimTokenPepperConfig = Config.redacted("CLAIM_TOKEN_PEPPER").pipe(
  Config.withDefault(Redacted.make("")),
);

const toBadRequestError = (message: string) => new SourceCreationBadRequestError({ message });
const toInternalError = (message: string) => new SourceCreationInternalError({ message });

const generateClaimToken = (): string => {
  const bytes = new Uint8Array(CLI_CLAIM_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
};

const hashClaimValue = ({
  claimToken,
  pepper,
}: {
  readonly claimToken: string;
  readonly pepper: Redacted.Redacted<string>;
}): string =>
  createHash("sha256")
    .update("cli_claim_token")
    .update("\0")
    .update(Redacted.value(pepper))
    .update("\0")
    .update(claimToken)
    .digest("hex");

export const SourceCreationServiceLive = Layer.effect(
  SourceCreationService,
  Effect.gen(function* () {
    const principalRepository = yield* PrincipalRepository;
    const principalClaimRepository = yield* PrincipalClaimRepository;
    const sourceRepository = yield* SourceRepository;
    const sourceSyncService = yield* SourceSyncService;

    const resolveUserPrincipal = (currentUser: User) =>
      Effect.gen(function* () {
        const maybePrincipal = yield* principalRepository
          .findUserPrincipal(currentUser.userId)
          .pipe(Effect.mapError(() => toInternalError("Failed to resolve principal.")));

        if (Option.isNone(maybePrincipal)) {
          return yield* Effect.fail(toInternalError("Missing user principal."));
        }

        return maybePrincipal.value;
      });

    const resolveCreatePrincipal = (currentUser: Option.Option<User>) =>
      Effect.gen(function* () {
        if (Option.isSome(currentUser)) {
          const principal = yield* resolveUserPrincipal(currentUser.value);
          return { principal, isAnonymous: false } as const;
        }

        const principal = yield* principalRepository
          .createAnonymousWalletPrincipal()
          .pipe(Effect.mapError(() => toInternalError("Failed to create anonymous principal.")));

        return { principal, isAnonymous: true } as const;
      });

    const createOnchainSource = ({
      principalId,
      walletAddress,
      name,
    }: {
      readonly principalId: PrincipalId;
      readonly walletAddress: string;
      readonly name?: string | undefined;
    }) =>
      Effect.gen(function* () {
        const parsedAddress = parseCryptoAddress(walletAddress);
        if (parsedAddress === null) {
          return yield* Effect.fail(toBadRequestError("Invalid crypto address."));
        }

        const sourceName =
          name ?? `${parsedAddress.address.slice(0, 5)}...${parsedAddress.address.slice(-5)}`;

        const created = yield* sourceRepository
          .createOrReuseOnchainSource({
            principalId,
            chainType: parsedAddress.chainType,
            walletAddress: parsedAddress.address,
            name: sourceName,
          })
          .pipe(Effect.mapError(() => toInternalError("Failed to create or reuse source.")));

        return { ...created, parsedAddress };
      });

    const loadClaimTokenPepper = Effect.gen(function* () {
      const pepper = yield* Effect.configProviderWith((provider) =>
        provider
          .load(claimTokenPepperConfig)
          .pipe(Effect.mapError(() => toInternalError("Missing claim token pepper."))),
      );
      if (Redacted.value(pepper).trim() === "") {
        return yield* Effect.fail(toInternalError("Missing claim token pepper."));
      }
      return pepper;
    });

    const createCliClaim = ({
      principalId,
      sourceId,
      chainType,
      walletAddress,
      year,
      jurisdiction,
      pepper,
    }: {
      readonly principalId: PrincipalId;
      readonly sourceId: SourceId;
      readonly chainType: ChainType;
      readonly walletAddress: string;
      readonly year: number;
      readonly jurisdiction: string;
      readonly pepper: Redacted.Redacted<string>;
    }) =>
      Effect.gen(function* () {
        const requestId = crypto.randomUUID();
        const claimToken = generateClaimToken();
        const expiresAt = Timestamp.addMillis(Timestamp.now(), CLI_CLAIM_TTL_MILLIS).toDate();

        yield* principalClaimRepository
          .create({
            principalId,
            sourceId,
            requestId,
            claimType: "cli_claim_token",
            claimValueHash: hashClaimValue({ claimToken, pepper }),
            chainType,
            walletAddress,
            year,
            jurisdiction,
            expiresAt,
          })
          .pipe(Effect.mapError(() => toInternalError("Failed to create claim token.")));

        return {
          requestId,
          claimToken,
          expiresAt: expiresAt.toISOString(),
        };
      });

    const startSync = ({
      principalId,
      sourceId,
    }: {
      readonly principalId: string;
      readonly sourceId: string;
    }) =>
      sourceSyncService
        .startSourceSyncJob({
          principalId,
          sourceId,
        })
        .pipe(
          Effect.mapError((error) => {
            switch (error._tag) {
              case "UnsupportedProviderError":
                return toBadRequestError(`Unsupported provider: ${error.provider}`);
              case "SourceNotFoundError":
                return toBadRequestError("No source found. Connect a source first.");
              case "SourceSyncQueueError":
                return toInternalError("Failed to enqueue source sync job.");
              default:
                return toInternalError("Failed to start source sync.");
            }
          }),
        );

    const createSource: SourceCreationServiceShape["createSource"] = ({ currentUser, payload }) =>
      Effect.gen(function* () {
        const { principal, isAnonymous } = yield* resolveCreatePrincipal(currentUser);
        const created = yield* createOnchainSource({
          principalId: principal.id,
          walletAddress: payload.walletAddress,
          name: payload.name,
        });

        const shouldStartSync = isAnonymous || payload.sync === true;
        if (!shouldStartSync) {
          return {
            source: created.source,
            created: created.created,
            syncJob: null,
            claim: null,
          };
        }

        const maybeClaimTokenPepper = isAnonymous
          ? Option.some(yield* loadClaimTokenPepper)
          : Option.none<Redacted.Redacted<string>>();

        const syncJob = yield* startSync({
          principalId: principal.id,
          sourceId: created.source.id,
        });

        const claim = Option.isSome(maybeClaimTokenPepper)
          ? yield* createCliClaim({
              principalId: principal.id,
              sourceId: created.source.id,
              chainType: created.parsedAddress.chainType,
              walletAddress: created.parsedAddress.address,
              year: payload.year ?? new Date().getUTCFullYear(),
              jurisdiction: payload.jurisdiction ?? DEFAULT_CLAIM_JURISDICTION,
              pepper: maybeClaimTokenPepper.value,
            })
          : null;

        return {
          source: created.source,
          created: created.created,
          syncJob,
          claim,
        };
      });

    return SourceCreationService.of({
      createSource,
    } satisfies SourceCreationServiceShape);
  }),
);
