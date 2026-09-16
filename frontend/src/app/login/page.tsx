import { connection } from "next/server";
import LoginForm from "./LoginForm";
import { demoCredentialsVisible } from "./deployment";

export default async function LoginPage() {
  await connection();
  return <LoginForm showDemoCredentials={demoCredentialsVisible(process.env)} />;
}
