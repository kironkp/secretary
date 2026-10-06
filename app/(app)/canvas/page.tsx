// The Canvas is a view inside the Dashboard since SEC-A006 (Kiron: "make it
// make sense"); the old address still lands on it.
import { redirect } from "next/navigation";

export default function CanvasPage() {
  redirect("/dashboard?view=canvas");
}
