### From 1.10.0, a link's kind is one of four

The database refuses a link whose `entity_type` is not `area`, `cell`, `device` or `gateway`, with HTTP 400. A
link your site already holds with another word is kept: db-init's log names it at each boot until you give it one
of the four or delete it.
