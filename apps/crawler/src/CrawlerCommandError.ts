import { Schema } from "effect"

export class CrawlerCommandError extends Schema.TaggedError<CrawlerCommandError>()(
  "CrawlerCommandError",
  {
    message: Schema.String,
  }
) {}
