type DeploymentEnvironment = Readonly<Record<string, string | undefined>>;

export function demoCredentialsVisible(environment: DeploymentEnvironment): boolean {
  const deploymentMode = environment.DEPLOYMENT_MODE?.trim().toLowerCase();
  if (deploymentMode === "demo") return true;
  if (deploymentMode === "production") return false;
  if (deploymentMode) return false;
  return environment.SEED_DEMO_USERS?.trim().toLowerCase() !== "false";
}
