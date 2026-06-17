import { UserMessage } from "picoagents-ts";
import type { StructuredOutputFormat } from "picoagents-ts";
import { createExampleModelClient } from "../shared/modelClient.js";
import { section } from "../shared/printing.js";

interface PersonInfo {
  name: string;
  age: number;
  occupation: string;
  skills: string[];
}

const personInfoFormat: StructuredOutputFormat = {
  name: "PersonInfo",
  description: "Structured profile information for one person.",
  schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The person's full name." },
      age: { type: "integer", description: "The person's age in years." },
      occupation: { type: "string", description: "The person's job or profession." },
      skills: {
        type: "array",
        description: "The person's key skills.",
        items: { type: "string" }
      }
    },
    required: ["name", "age", "occupation", "skills"]
  }
};

export async function main(): Promise<void> {
  section("Structured Output Example");

  const fallbackProfile: PersonInfo = {
    name: "Alice",
    age: 28,
    occupation: "Software engineer",
    skills: ["Python", "JavaScript", "machine learning"]
  };

  const client = createExampleModelClient([
    {
      content: JSON.stringify(fallbackProfile),
      structuredOutput: fallbackProfile
    }
  ]);

  const result = await client.create(
    [
      new UserMessage({
        content:
          "Create a profile for a software engineer named Alice who is 28 years old and skilled in Python, JavaScript, and machine learning.",
        source: "user"
      })
    ],
    { outputFormat: personInfoFormat }
  );

  const person = (result.structuredOutput ?? JSON.parse(result.message.content)) as PersonInfo;
  console.log(`Name: ${person.name}`);
  console.log(`Age: ${person.age}`);
  console.log(`Occupation: ${person.occupation}`);
  console.log(`Skills: ${person.skills.join(", ")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
