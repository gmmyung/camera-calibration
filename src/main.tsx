import { render } from "preact";
import { App } from "./app/App";
import "./styles.css";

const root = document.getElementById("app");
if (!root) throw new Error("The application root element is missing.");
render(<App />, root);
