# flatter
Fun with SQLite &amp; deno

I'm basically just playing around with SQLite and deno, and seeing how far I can push this
whole thing.

The interesting thing about SQLite (apart from the fact that it is amazing in almost all respects) is that
you can specify column types that do not exist in the SQL standard -- or even in the SQLite documentation.

This means we can provide a lot of hints to typescript about what the thing is in the database, and how
to convert it back into a TypeScript object at runtime, while extracting most of the data out of properties
into columns, and vice versa. Or at least, I think that's true. And that's the fun I'm having, I guess.

## TODO

This is where I've got to at 2254 on 20 Nov 2024:

[X] DATETIME objects need to come out of the database as Date objects, rather than as astrings

