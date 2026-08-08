import { render } from "preact";
import { App } from "./app/App";
import { DisplayBoardPage } from "./app/DisplayBoardPage";
import { patternFromDisplayBoardUrl } from "./domain/display-board";
import "./styles.css";

const root = document.getElementById("app");
if (!root) throw new Error("The application root element is missing.");
const currentUrl = new URL(window.location.href);
if (currentUrl.searchParams.get("view") === "board") {
  try {
    render(<DisplayBoardPage pattern={patternFromDisplayBoardUrl(currentUrl)} />, root);
  } catch (error) {
    render(
      <DisplayBoardPage initialError={error instanceof Error ? error.message : String(error)} />,
      root,
    );
  }
} else {
  render(<App />, root);
}
