import { createFileRoute } from "@tanstack/react-router";
import { AuthForm } from "../components/auth/AuthForm";

export const Route = createFileRoute("/signup")({
  component: () => <AuthForm mode="signup" />,
});
