export const logoutFromApp = async ({
  logout,
  clearClientState,
  navigateToLogin,
}: {
  readonly logout: () => Promise<unknown>
  readonly clearClientState: () => void
  readonly navigateToLogin: () => Promise<unknown>
}): Promise<void> => {
  await logout()
  clearClientState()
  await navigateToLogin()
}
