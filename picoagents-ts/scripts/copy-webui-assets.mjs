import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const source = path.join(root, "src", "webui", "ui");
const destination = path.join(root, "dist", "webui", "ui");
const skillsSource = path.join(root, "src", "skills");
const skillsDestination = path.join(root, "dist", "skills");

await rm(destination, { recursive: true, force: true });
await mkdir(path.dirname(destination), { recursive: true });
await cp(source, destination, { recursive: true });

await rm(skillsDestination, { recursive: true, force: true });
await mkdir(path.dirname(skillsDestination), { recursive: true });
await cp(skillsSource, skillsDestination, { recursive: true });
