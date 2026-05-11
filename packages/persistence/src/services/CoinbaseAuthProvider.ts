/**
 * CoinbaseAuthProvider - Service definition for Coinbase OAuth authentication
 *
 * Implements the AuthProvider interface from core for Coinbase OAuth2 authentication.
 *
 * @module CoinbaseAuthProvider
 */

import * as Context from "effect/Context"
import type { AuthProvider } from "@my/core/authentication"

/**
 * CoinbaseAuthProvider - Context.Tag for dependency injection
 */
export class CoinbaseAuthProvider extends Context.Tag("CoinbaseAuthProvider")<
  CoinbaseAuthProvider,
  AuthProvider
>() {}
