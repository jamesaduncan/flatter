/**
 * @module Flatter
 * This module provides a simple ORM that explicitly takes advantage of
 * some of the features and quirks of SQLite. It does not attempt to abstract
 * the database away in any sense, focusing on providing transparent interactions
 * with SQLite tables.
 *
 * ## Features:
 * - Explicit handling of SQLite table definitions and interactions.
 * - Support for type conversions between JavaScript and SQLite.
 * - Object serialization for nested objects with JSON support.
 * - Transparent handling of UUIDs for persistent objects.
 * - Provides `save`, `load`, and transactional capabilities.
 * - Enforces relationships via SQLite foreign keys.
 *
 * ## Usage:
 *
 * ### Save and Load:
 * Create objects, populate them with data, call `save` to persist, and use
 * `loadWithUUID` or `load` to retrieve data from the database.
 *
 * @example
 * ```typescript
 * import Flatter from "./Flatter.ts";
 *
 * class Address extends Flatter {
 *   street = "";
 *   city = "";
 *   postcode = "";
 *
 *   constructor(template) {
 *     super();
 *     if (template) Object.assign(this, template);
 *   }
 *
 *   static {
 *     this.init();
 *   }
 * }
 *
 * class User extends Flatter {
 *   username = "";
 *   created = new Date();
 *   shippingAddress = new Address();
 *
 *   constructor(template) {
 *     super();
 *     if (template) Object.assign(this, template);
 *   }
 *
 *   static {
 *     this.init();
 *   }
 * }
 *
 * const user = new User({
 *   username: "john",
 *   shippingAddress: new Address({ street: "123 Main St", city: "Springfield" })
 * });
 *
 * user.save();
 * console.log(user);
 * console.log(User.loadWithUUID(user.uuid));
 * ```
 *
 * @remarks
 * - This module is designed for SQLite and takes advantage of its specific features.
 * - It relies on UUIDs for uniquely identifying records and supports nested object serialization.
 *
 * @see {@link https://sqlite.org/ | SQLite Documentation}
 */

import { Database } from "jsr:@db/sqlite@0.11";
import Pluralize from "jsr:@wei/pluralize@8.0.2";
import julian from "npm:julian@0.2.0";
import debug from "npm:debug@4.3.7";
import criterion from "npm:criterion@0.4.0-rc.1";
import * as acorn from "npm:acorn@8.14.0";

/* some convenience methods for debugging */
const sqllog = debug('flatter:sql');
const flog   = debug('flatter:main');

let DBConnection : Database;

type TObjectLoadCache = {
    [key: string] : Storable;
    toplevel : Storable;
}

type TDBTypeConversion = {
    toPlaceholder? : string;
    toDBValue? ( e: unknown, cache? : TObjectLoadCache) : string | string;
    toJSValue? ( e: string, cache? : TObjectLoadCache) : unknown;
}

type TDBTypeConversions = {
    [key: string] : TDBTypeConversion;
}

type TRowInfo = {
    cid : string;
    name : string;
    type : string;
    notnull : number;
    dflt_value: unknown;
    pk : number;

    fk? : object;
}

type TTables = {
    [key : string] : TTableInfo;
}

type TTableInfo = {
    [key : string] : TRowInfo;
}

interface Storable {
    uuid   : string;

    save() : boolean;
    dbValues( cache? : TObjectLoadCache ) : string[];
}

type TTypeCache = {
    [key : string] : Loadable;
}

/* This is the static interface for Flatter */
interface Loadable {
    new() : Storable;

    tableInfo : TTables;
    DBTypeConversions : TDBTypeConversions;
    TypeCache : TTypeCache;

    get tablename() : string;
    get dbColumns() : string[];
    get dbPlaceholders() : string[];

    get database() : Database;

    load( criteria : object, cache? : object) : Storable[];
    loadWithUUID( aUUID : string, cache? : object) : Storable;

    init() : void;

    useDatabase( aDatabase : string ) : void;
    useDatabase( aDatabase : Database ) : void;

}

type TProxy = {
    class : string;
    uuid  : string;
}

function log<This, Args extends unknown[], Return>(
    target: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<
      This,
      (this: This, ...args: Args) => Return
    >
  ) {
    const methodName = String(context.name);
  
    function replacementMethod(this: This, ...args: Args): Return {
      flog(`Entering '${methodName}(${Deno.inspect(args)})'.`);
      const result = target.call(this, ...args);
      flog(`Exiting '${methodName}'.`);
      return result;
    }
  
    return replacementMethod;
}

function staticImplements<T>() {
    return <U extends T>(constructor: U) => { constructor };
}

/**
 * Flatter is is the class that should be used as a base
 * class by any object that wants to persist to the magical
 * SQLite database.
 */
@staticImplements<Loadable>()
class Flatter {
    uuid: string;

    /**
     * Maps database data types to their corresponding conversion logic for serialization and deserialization.
     *
     * The `DBTypeConversions` static field defines the conversion rules for translating between SQLite
     * data types and JavaScript types. This ensures that data is correctly transformed when it is written to
     * or read from the database.
     *
     * ## Behavior:
     * - Each key represents a SQLite data type (e.g., `TEXT`, `UUID`, `DATETIME`, `OBJECT`).
     * - The value is an object specifying optional methods for:
     *   - `toPlaceholder`: Defines the SQL placeholder used for this type (e.g., `?`, `json(?)`).
     *   - `toDBValue`: A function to convert a JavaScript value to a database-compatible format.
     *   - `toJSValue`: A function to convert a database value back to a JavaScript value.
     *
     * @type {TDBTypeConversions}
     *
     * @example
     * ```typescript
     * Flatter.declareDBType('DATETIME', {
     *   toDBValue: (value: Date) => value.toISOString(),
     *   toJSValue: (value: string) => new Date(value)
     * });
     *
     * class User extends Flatter {
     *   username = "";
     *   created = new Date();
     *
     *   static {
     *     this.init();
     *   }
     * }
     * ```
     *
     * @remarks
     * - The `DBTypeConversions` is a shared static field, meaning it applies to all instances of `Flatter`.
     * - Custom types must be declared using the `declareDBType` method before use in SQL schemas.
     * - Conversion logic ensures type safety and compatibility with SQLite features like JSON fields and foreign keys.
     *
     * @see {@link declareDBType} - Method to define new type conversion rules.
     * @see {@link dbValues} - Uses `DBTypeConversions` to determine values for SQL queries.
     */
    static DBTypeConversions : TDBTypeConversions = {};

    /**
     * Stores metadata about the database table structure for the class.
     *
     * The `tableInfo` static field is a cache containing the schema information for the database table
     * associated with the class. This includes details about the columns, their data types, primary keys,
     * foreign keys, and other constraints.
     *
     * ## Behavior:
     * - Populated during the `init` method by querying the database for the table schema using SQLite's `PRAGMA table_info`.
     * - Includes additional metadata for foreign key relationships using SQLite's `PRAGMA foreign_key_list`.
     * - Organized as an object where keys represent column names, and values provide detailed information about each column.
     *
     * @type {TTables}
     *
     * @example
     * ```typescript
     * class User extends Flatter {
     *   username = "";
     *   created = new Date();
     *
     *   static {
     *     this.init();
     *   }
     * }
     *
     * console.log(User.tableInfo);
     *```
     *
     * @remarks
     * - This field is automatically managed by the `init` method and should not be modified manually.
     * - The `tableInfo` structure is specific to the class and provides quick access to column metadata.
     * - Useful for generating dynamic SQL queries and ensuring data integrity during database operations.
     *
     * @see {@link init} - Populates the `tableInfo` field during table initialization.
     * @see {@link dbColumns} - Retrieves column names from `tableInfo` for use in queries.
     * @see {@link dbValues} - Uses `tableInfo` to match object properties to database columns.
     */
    static tableInfo : TTables = ({} as TTables);

    /**
     * A static cache for storing mappings of class names to their corresponding `Flatter` subclass constructors.
     *
     * The `TypeCache` is used to dynamically resolve and instantiate the correct class types during object deserialization
     * and database interactions. This is particularly useful for handling nested objects and ensuring type consistency.
     *
     * ## Behavior:
     * - Populated automatically during the `init` method, where each `Flatter` subclass registers itself.
     * - Acts as a shared registry for all subclasses of `Flatter`.
     * - Enables the ORM to deserialize objects into their original class types by looking up the class name in the cache.
     * - Prevents redundant operations by storing reusable type information.
     *
     * @type {TTypeCache}
     *
     * @remarks
     * - This field is automatically managed and should not be modified manually.
     * - Critical for resolving nested objects and relationships in a type-safe manner.
     * - Facilitates efficient type handling and object reconstruction during database operations.
     *
     * @see {@link init} - Adds the current class to the `TypeCache` during initialization.
     * @see {@link loadWithUUID} - Uses `TypeCache` to resolve the correct class for deserialized objects.
     * @see {@link dbValues} - References `TypeCache` to serialize nested objects.
     */
    static TypeCache : TTypeCache = {};

    /**
     * A static registry of recognized database types for the `Flatter` ORM.
     *
     * The `DBTypes` field serves as an internal mapping of database data types that are supported
     * and understood by the ORM. It ensures consistent handling of these types across various operations,
     * such as schema generation, data serialization, and deserialization.
     *
     * ## Behavior:
     * - Populated with predefined database types like `TEXT`, `UUID`, `DATETIME`, and `OBJECT`.
     * - Used internally by the ORM to validate and process data types in table definitions and queries.
     * - Ensures that the ORM can correctly interpret and work with custom or complex types when declared.
     *
     * @type {object}
     *
     * @remarks
     * - This field is not intended to be modified directly; use `declareDBType` to register new types.
     * - It supports extensibility by allowing developers to define and integrate custom database types.
     * - Plays a critical role in ensuring type safety and compatibility between JavaScript and SQLite.
     *
     * @see {@link declareDBType} - Method to register additional database types.
     * @see {@link DBTypeConversions} - Uses `DBTypes` to define type conversion logic.
     */
    private static DBTypes = {};

    /**
     * Returns the current object itself, enabling serialization of the object into the database.
     *
     * The `flatter` getter is a special property used to serialize the object into the database
     * when storing nested objects. It provides a direct reference to the instance, allowing the
     * object to be saved as a JSON field in SQLite.
     *
     * ## Behavior:
     * - When saving an object, this getter ensures the object itself is serialized into the database
     *   as a `JSON` type if required by the schema.
     * - Acts as a marker property, enabling the `Flatter` ORM to handle nested object structures.
     *
     * @returns {Flatter} - The current instance of the `Flatter` object.
     *
     * @example
     * ```typescript
     * class User extends Flatter {
     *   username = "";
     *   profile = { bio: "Hello, world!", age: 30 };
     * 
     *   constructor( aTemplate ) {
     *      if (aTemplate) Object.assign(this, aTemplate); 
     *   }
     * 
     *   static {
     *     this.init();
     *   }
     * }
     *
     * const user = new User({ username: "john", profile: { bio: "Hello!", age: 25 } });
     * console.log(user.flatter); // Outputs the `user` object itself
     * ```
     *
     * @remarks
     * - This getter is particularly useful when persisting objects that have nested structures or additional metadata.
     * - The `flatter` field is expected to be serialized as JSON in the database.
     *
     * @see {@link dbValues} - Uses the `flatter` field during database operations.
     */
    get flatter () : Flatter {
        return this;
    }

    /**
     * Returns the name of the database table associated with the class.
     *
     * The table name is automatically determined by pluralizing the class name. 
     * This convention simplifies mapping between classes and their corresponding database tables.
     *
     * ## Behavior:
     * - Converts the class name to its plural form using the `Pluralize` library.
     * - Ensures consistent table naming for all `Flatter` subclasses.
     *
     * @returns {string} - The pluralized class name, used as the table name in the database.
     *
     * @example
     * ```typescript
     * class User extends Flatter {
     *
     *   static {
     *     this.init();
     *   }
     * }
     *
     * console.log(User.tablename); // Outputs: "Users"
     * ```
     *
     * @remarks
     * - This getter is static and should be accessed directly from the class (e.g., `User.tablename`).
     * - Relies on the `Pluralize` library to handle pluralization, which covers common English rules but may not handle all edge cases.
     *
     * @see {@link init} - Uses the table name to initialize the database metadata.
     */
    static get tablename() : string {
        return Pluralize(this.name);
    }

    /**
     * Constructs a new instance of a `Flatter` object.
     *
     * The constructor generates a unique UUID for the object and initializes it
     * as a persistent entity. This UUID serves as the primary key in the corresponding
     * database table.
     *
     * ## Behavior:
     * - Automatically assigns a UUID to the instance upon creation.
     * - Designed to be used by subclasses of `Flatter` to inherit persistence behavior.
     *
     * @example
     * ```typescript
     * class User extends Flatter {
     *   username = "";
     *   constructor(template) {
     *     super();
     *     if (template) {
     *       Object.assign(this, template);
     *     }
     *   }
     * }
     *
     * const user = new User({ username: "john" });
     * console.log(user.uuid); // A unique UUID is automatically generated
     * ```
     *
     * @remarks
     * - Subclasses of `Flatter` should call `super()` in their constructors to ensure the UUID is set.
     * - This constructor does not initialize any fields beyond the UUID; subclasses are responsible for their own properties.
     *
     * @throws {Error} - Throws an error if UUID generation fails, though this is highly unlikely.
     */
    constructor( aTemplate? : object ) {
        this.uuid = crypto.randomUUID();
        if (aTemplate) Object.assign(this, aTemplate);
    }

    /**
     * Initializes the database table and metadata for the class.
     *
     * This method is intended to be called in a static block for each subclass of `Flatter`.
     * It performs the following tasks:
     * - Ensures the SQLite database connection is established.
     * - Checks if the corresponding database table exists; if not, creates it by parsing the class definition.
     * - Retrieves and caches the table's schema information, including columns and foreign key constraints.
     * - Registers the class in the `TypeCache` for use during serialization and deserialization.
     *
     * ## Behavior:
     * - Uses the `tablename` property of the class to define and query the database schema.
     * - Uses `acorn` to parse the source code of the class definition to generate the database schema if it doesn't exist.
     * - Caches the table schema and foreign key metadata for efficient database interactions.
     *
     * @throws {Error} - Throws an error if the database connection cannot be established or queried.
     *
     * @example
     * ```typescript
     * class Address extends Flatter {
     *   street = "";
     *   city = "";
     *   postcode = "";
     *
     *   static {
     *     this.init();
     *   }
     * }
     * ```
     *
     * @remarks
     * - This method should not be called manually; it is meant to be invoked automatically in static blocks of subclasses.
     * - If the table already exists, it does not modify the schema but updates the cached metadata.
     *
     * @see {@link useDatabase} - Ensures the database connection is set before initialization.
     * @see {@link tablename} - Determines the table name for the current class.
     */
    static init() {
        const typename  = this.name;
        const tablename = this.tablename;

        const thisSource = this.toString();
        //const model = cherow.parse( thisSource );
        const model = acorn.parse( thisSource, { ecmaVersion: 2023, allowReserved: true } );
//        console.log(model);
        // @ts-ignore: this is what I want to do. It's ok. If it won't parse then it will fail with what I want it to fail with
        const properties = model.body.at(0)?.body?.body.filter( e => e.type == 'PropertyDefinition' );
        const propertyObjects = Object.fromEntries( properties.map( (e : unknown) => {
// @ts-ignore: this really is what I want to do, and its ok.
            return [ e.key.name, e.value ];
        }) );

        let sqlDefinition : string = "";

        const astTypeTranslation = {
            'String': "TEXT",
            'Date': "DATETIME",
            'Integer': 'INTEGER',
            'Float': 'REAL',
            'OBJECT': 'OBJECT'
        };

        /* @ts-ignore: hairy, but intended. We're dealing with the AST here, and it is a bit complex! */
        {
            sqlDefinition = `CREATE TABLE ${tablename} (\n`;
            const sqlFields = [ [ 'uuid', 'UUID PRIMARY KEY NOT NULL' ] ];

            const isNumber = function isNumber(value : unknown) {
                return typeof value === 'number';
            };

            sqlFields.push( ...Object.entries( propertyObjects ).map( ( [key, value] ) => {
                if ( value.type == 'Literal' ) {
                    if ( !isNumber( value.value )) {
                        return [ key, 'String' ];
                    } else {
                        if ( parseInt( value.value )) return [ key, 'Integer' ];
                        else return [key, 'Float' ];
                    }
                } else if ( value.type == 'ObjectExpression' || value.type == 'ArrayExpression') {
                    return [ key, 'OBJECT' ]
                }
                return [key, value.callee?.name || value];
            }) );
            sqlFields.push( ['flatter', 'OBJECT'])

            const fks : string[][] = [];
            sqlDefinition += sqlFields.map( ([ key, type ]) => {
                if ( astTypeTranslation[(type as keyof object)] ) {
                    return `\t${key} ${ astTypeTranslation[(type as keyof object)]}`
                } else {
                    if (key != 'uuid') fks.push([key, type]);
                    return `\t${key} ${type}`;
                }
            }).join(",\n");

            if (fks.length) sqlDefinition += ",\n";
            sqlDefinition += fks.map( ([key, type ]) => {
                //console.log(type);
                return `\tFOREIGN KEY(${key}) REFERENCES ${Pluralize(type)}(uuid)`
            }).join(", ");

            sqlDefinition += `\n)`;
        }

        if (!DBConnection) {
            Flatter.useDatabase("flatter.sqlite");
        }


        this.TypeCache[typename] = this;

        flog(`in init() for ${typename}`)

        const tableDetails = DBConnection.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${tablename}'`).get();
        if (!tableDetails) {
            /* we need to set up the table */
            DBConnection.run( sqlDefinition );
        }

        const info = DBConnection.prepare(`PRAGMA table_info(${tablename})`).all();
        info.forEach( (infoRow) => {
            const castInfo : TRowInfo = (infoRow as TRowInfo);
            this.tableInfo[typename]||= {};
            this.tableInfo[typename][ castInfo.name ] = castInfo;
        })

        const fk_sql  = `PRAGMA foreign_key_list(${tablename})`;
        const fk_rows = DBConnection.prepare(fk_sql).all();
        fk_rows.forEach( (row) => {            
            this.tableInfo[typename][row.from].fk = (row as object);
        })
    }

    /**
     * Configures the SQLite database connection for the `Flatter` ORM.
     *
     * The `useDatabase` method sets the active database connection to be used by all subclasses
     * of `Flatter`. This connection is required for all database operations, including table
     * initialization, saving objects, and loading data.
     *
     * ## Behavior:
     * - Accepts either a `Database` instance or a string representing the database file path.
     * - If a string is provided, a new `Database` instance is created using the specified file path.
     * - Configures SQLite with essential settings, such as enabling write-ahead logging (WAL)
     *   and enforcing foreign key constraints.
     *
     * @param {Database | string} aDatabase - The database to use, either as an existing `Database` instance
     *   or a string specifying the database file path.
     *
     * @returns {void}
     *
     * @throws {Error} - Throws an error if the provided database is invalid or cannot be connected.
     *
     * @remarks
     * - This method should be called before any database operations are performed, typically during initialization.
     * - If not explicitly called, the ORM defaults to using a SQLite database named `flatter.sqlite`.
     * - Proper configuration of the database is critical for ensuring data integrity and enforcing relationships.
     *
     * @see {@link init} - Initializes the table schema using the active database connection.
     * @see {@link save} - Relies on the configured database connection to persist objects.
     * @see {@link loadWithUUID} - Uses the active database connection to retrieve objects.
     */
    static useDatabase( aDatabase : Database | string) : void {
        if ( aDatabase instanceof Database ) {
            DBConnection = aDatabase;
        } else {
            DBConnection = new Database("flatter.sqlite");
        }
        DBConnection.run('PRAGMA journal_mode = WAL;')        
        DBConnection.run('PRAGMA FOREIGN_KEY = ON;')                    
    }

    static get database() : Database {
        return DBConnection;
    }

    /**
     * Retrieves the list of column names for the database table associated with the class.
     *
     * The `dbColumns` method provides an array of column names for the current class's table
     * based on the schema information cached in `tableInfo`. These column names are used
     * for generating SQL queries and mapping object properties to database fields.
     *
     * ## Behavior:
     * - Extracts column names from the `tableInfo` cache, which is populated during initialization.
     * - Ensures that only the columns defined in the schema are included, maintaining consistency
     *   between the class structure and the database table.
     *
     * @returns {string[]} - An array of column names for the class's database table.
     *
     * @throws {Error} - Throws an error if the table information is not initialized or if the class is not registered.
     *
     * @remarks
     * - This method is typically used internally by the ORM for operations such as `INSERT`, `UPDATE`, and `SELECT`.
     * - Ensures type safety and alignment with the defined database schema.
     *
     * @see {@link tableInfo} - The source of the schema information used to determine column names.
     * @see {@link dbPlaceholders} - Generates SQL placeholders corresponding to the columns.
     * @see {@link dbValues} - Maps object properties to the corresponding column values.
     */
    static get dbColumns() : string[] {
        return Object.keys(this.tableInfo[this.name]);
    }

    /**
     * Generates the SQL placeholders for the columns of the class's database table.
     *
     * The `dbPlaceholders` method returns an array of SQL placeholders corresponding to the
     * columns in the database table associated with the class. These placeholders are used
     * in SQL `INSERT` and `UPDATE` statements to represent the values being inserted or updated.
     *
     * ## Behavior:
     * - For standard columns, it returns a simple `?` placeholder.
     * - For custom or complex types, it uses the placeholder defined in `DBTypeConversions`, such as `json(?)`.
     * - Matches the order and structure of the column names provided by `dbColumns`.
     *
     * @returns {string[]} - An array of SQL placeholders for the class's database table.
     *
     * @throws {Error} - Throws an error if the `DBTypeConversions` or `tableInfo` is not properly initialized.
     *
     * @remarks
     * - This method ensures that the placeholders align with the column order and types.
     * - It is used internally by the ORM during SQL query generation for `INSERT` and `UPDATE` operations.
     *
     * @see {@link dbColumns} - Provides the column names corresponding to the placeholders.
     * @see {@link dbValues} - Maps object properties to the placeholder values.
     * @see {@link DBTypeConversions} - Defines the custom placeholder logic for non-standard data types.
     */
    static get dbPlaceholders() : string[] {
        const theClass = (this as Loadable);
        const typename = this.name;
        const tableInfoValues = Object.values(this.tableInfo[typename]);
        return tableInfoValues.map( (e: TRowInfo) => {
            if ( this.tableInfo[ Pluralize.singular( e.type )]) {
                // this is an object type, because it is a class/
                const placeholder = theClass.DBTypeConversions["UUID"].toPlaceholder;
                return placeholder || '?';
            } else {
                const placeholder = theClass.DBTypeConversions[ e.type ].toPlaceholder;            
                if ( typeof(placeholder) == 'string' ) {
                    return placeholder;
                } else {
                    return '?';
                }
            }
        })
    }

    /**
     * Generates the values to be inserted into or updated in the database.
     *
     * The `dbValues` method maps the current object's properties to the corresponding column values
     * based on the schema information in `tableInfo`. These values are used in conjunction with
     * the placeholders generated by `dbPlaceholders` to construct SQL `INSERT` or `UPDATE` queries.
     *
     * ## Behavior:
     * - Iterates over the table's schema to retrieve the value for each column from the object.
     * - Applies type conversion using `DBTypeConversions` where applicable (e.g., serializing objects or dates).
     * - Handles nested objects by saving them and substituting their UUIDs in the parent object.
     * - Avoids redundant writes for objects already present in the `cache` during a transaction.
     *
     * @param {TObjectLoadCache} [cache] - A cache of objects already written in the current operation.
     *   Used to avoid duplicate writes and resolve circular references for nested objects.
     *
     * @returns {string[]} - An array of values corresponding to the table columns.
     *
     * @throws {Error} - Throws an error if the schema information is incomplete or if type conversion fails.
     *
     * @remarks
     * - This method ensures that the values are properly serialized and match the expected database format.
     * - Used internally during the `save` operation to prepare data for insertion or update.
     * - Relies on `DBTypeConversions` for custom data type handling and on `tableInfo` for column mapping.
     *
     * @see {@link dbPlaceholders} - Generates the corresponding SQL placeholders for these values.
     * @see {@link tableInfo} - Provides the schema information required to map columns to values.
     * @see {@link save} - Uses `dbValues` to prepare data for database operations.
     */
    @log
    dbValues( cache : TObjectLoadCache ) : string[] {
        const theClass = (this.constructor as Loadable);
        const tableInfo = theClass.tableInfo;

        return Object.values( tableInfo[theClass.name] ).map( ( row : TRowInfo ) : string => {            
            const value = Reflect.get(this, row.name);            
            const infoRow = theClass.DBTypeConversions[row.type];
            if (row.fk && value instanceof Flatter) {
                return (value as Storable).uuid;
            }
            const toDBValue = infoRow.toDBValue;
            if (!toDBValue) {
                return (value as string);
            }
            if (toDBValue) {
                if ( typeof(toDBValue) == 'string' ) return toDBValue;
                const val = toDBValue( value, cache );
                return val;
            }
            return '';
        })
    }

    /**
     * Saves the current object to the SQLite database.
     *
     * This method performs an `INSERT OR REPLACE` operation in the corresponding database table.
     * It uses the object's UUID as the primary key to ensure uniqueness. If the object already exists in the database,
     * it will be updated; otherwise, a new record will be inserted.
     *
     * ## Behavior:
     * - If the object has nested `Flatter` objects, they are also saved recursively.
     * - Ensures that objects are not saved multiple times in the same transaction by utilizing a cache.
     * - Automatically handles the generation of placeholders and values for the SQL query based on the table schema.
     *
     * @param {TObjectLoadCache} [cache] - A cache of objects already written in this save operation.
     *   This avoids redundant writes and resolves circular references for nested objects.
     *   If not provided, a new cache is created for this save operation.
     *
     * @returns {boolean} - Returns `true` if the object was successfully saved.
     *
     * @throws {Error} - Throws an error if the save operation fails or if the database connection is not initialized.
     *
     * @example
     * ```typescript
     * const address = new Address({ street: "123 Main St", city: "Springfield", postcode: "12345" });
     * const user = new User({ username: "john", shippingAddress: address });
     *
     * user.save();
     *
     * console.log(User.loadWithUUID(user.uuid)); // Retrieves the saved user from the database
     * ```
     *
     * @remarks
     * - This method automatically wraps the save operation in a SQLite savepoint transaction.
     * - Foreign key constraints defined in the table schema are enforced during the save operation.
     *
     * @see {@link dbValues} - Determines the values to be inserted into the database.
     * @see {@link transact} - Handles transactional logic for save operations.
     */
    @log
    save( cache? : TObjectLoadCache ): boolean {
        flog(`{ uuid: '${this.uuid}' }).save()`)


        const tablename       = (this.constructor as Loadable).tablename;
        const columns         = (this.constructor as Loadable).dbColumns;
        const dbPlaceholders  = (this.constructor as Loadable).dbPlaceholders;
        const sql = `INSERT OR REPLACE INTO ${tablename} (${columns.join(", ")}) VALUES(${dbPlaceholders.join(", ")})`

        if (!cache) {
            cache = { toplevel: this };
            cache[ this.uuid ] = ({ uuid: this.uuid } as Storable);
        } else {
            // we've already done this.
            if (this.uuid == (cache.toplevel as Storable).uuid ) return true;
            if (cache[this.uuid]) return true;
        }

        const theUUID = this.uuid;

        this.transact( () => {
            const values = this.dbValues( cache );            
            sqllog(sql,values)
            const stmt = DBConnection.prepare(sql);
            stmt.run( values );
            cache[ theUUID ] = this;
        }, "Flatter_save");        

        cache[ this.uuid ] = ({ uuid: this.uuid } as Storable);

        return true;
    }

    /**
     * Executes a function within the context of a SQLite transaction.
     *
     * The `transact` method wraps a provided function in a SQLite savepoint transaction.
     * This ensures that changes made during the function's execution are either fully committed
     * or completely rolled back in case of an error, maintaining database consistency.
     *
     * ## Behavior:
     * - Begins a savepoint transaction before executing the provided function.
     * - If the function completes successfully, the transaction is committed.
     * - If an error occurs, the transaction is rolled back to the savepoint, ensuring no partial changes persist.
     * - Supports nested transactions using savepoints for granular control over database operations.
     *
     * @param {() => void} aTransaction - A function containing the database operations to execute
     *   within the transaction.
     * @param {string} [name] - An optional name for the savepoint. Defaults to `FLATNESTED` if not provided.
     *
     * @returns {void}
     *
     * @throws {Error} - Rethrows any error that occurs during the execution of the transaction function.
     *
     * @remarks
     * - This method is used internally by the ORM to manage transactional integrity during complex operations.
     * - Supports SQLite's savepoint mechanism for nested transactions, allowing multiple levels of rollback if needed.
     * - Improper use of transactions (e.g., uncommitted changes) may lead to database inconsistencies.
     *
     * @see {@link save} - Uses `transact` to ensure object persistence is atomic.
     * @see {@link load} - Can utilize transactions for batch operations.
     */
    @log
    public transact( aTransaction: () => void, name? : string ) {
        if ( !name ) name = "FLATNESTED"
        const begin    = `SAVEPOINT ${name}`;
        const release  = `RELEASE SAVEPOINT ${name}`;
        const rollback = `ROLLBACK TRANSACTION TO SAVEPOINT ${name}`;
        sqllog(begin)
        DBConnection.exec(begin);
        try {            
            aTransaction();
            sqllog(release)
            DBConnection.exec(release);
        } catch(e) {
            sqllog(rollback)
            DBConnection.exec(rollback);
            throw e; // we re-throw e so that the ORM consumer can act upon the failure.
        }        
    }

    /**
     * Loads an object from the database by its UUID.
     *
     * The `loadWithUUID` method retrieves a single object from the database using its unique UUID.
     * It deserializes the data, reconstructs the object as an instance of its original class,
     * and resolves any nested objects using the `TypeCache`.
     *
     * ## Behavior:
     * - Executes a `SELECT` query to fetch the row corresponding to the given UUID.
     * - If the row contains nested objects serialized as JSON, they are deserialized and resolved.
     * - Utilizes `TypeCache` to determine the correct class for the object and any nested structures.
     * - Caches the loaded object to avoid redundant deserialization and to handle circular references.
     *
     * @param {string} aUUID - The UUID of the object to load.
     * @param {object} [cache] - An optional cache to store and resolve objects during deserialization.
     *   This is particularly useful for nested objects and circular references.
     *
     * @returns {Storable} - The reconstructed object corresponding to the provided UUID.
     *
     * @throws {Error} - Throws an error if no object is found for the given UUID or if deserialization fails.
     *
     * @remarks
     * - This method is typically used to retrieve specific objects by their unique identifiers.
     * - Ensures that nested objects are correctly rehydrated into their respective class instances.
     * - The `cache` parameter is used internally to manage references during complex deserialization.
     *
     * @see {@link load} - Retrieves multiple objects based on search criteria.
     * @see {@link TypeCache} - Used to resolve class types during object reconstruction.
     * @see {@link save} - Ensures that objects are saved with unique UUIDs for retrieval.
     */
    @log
    public static loadWithUUID( aUUID : string, cache? : object) : Storable {        
        if (!cache) cache = { toplevel: aUUID }
        if (cache[ aUUID as keyof object]) return cache[ aUUID as keyof object ];

        const sql = `SELECT * FROM ${this.tablename} WHERE uuid = ?`;
        let row = DBConnection.prepare(sql).get(aUUID);
        if (!row) throw new Error(`no object with uuid ${aUUID} found`);

        type FlatterObject = {
            flatter : string;
            [key : string] : unknown;
        }

        if ( row.flatter ) {
            row = JSON.parse( (row as FlatterObject).flatter, (_key : string, value : unknown, _context? : string) => {
                if ( value instanceof Object) {
                    const theValue = (value as TProxy);
                    const aClass = this.TypeCache[ theValue.class ];
                    if (!aClass) return value;
                    const uuid   = theValue.uuid;
                    if (uuid == aUUID) return value;
                    const cachekey = (theValue.uuid as keyof object);
                    if ( !( cache[cachekey] )) {
                        const toCache = aClass.loadWithUUID( theValue.uuid, cache );
                        /* I'm using reflect here because of a weird type error in typescript.
                           I know its a bit of a hack, but it saves some shenanigans elsewhere. */
                        Reflect.set(cache, cachekey, (toCache as Storable));
                    }
                    return cache[cachekey];
                }
                return value;
            });
        }

        const entries = Object.entries( (row as object) );    
        const objectProperties = Object.fromEntries( entries.map( ([k,v]) => {            
            // here we need to check the data that we got out of the DB early on, and look
            // for an appropriate type conversion (toJSValue). If it exists, we need to run
            // it to get the value. If not, we can just use v, as it already does.
            const tableInfo = this.tableInfo[this.name];
            const rowType = tableInfo[k].type;
            const typeConversion = this.DBTypeConversions[ rowType ];
            if (typeConversion && typeConversion.toJSValue) {
                return [ k, {
                    writable: true,
                    enumerable: true,
                    configurable: true,
                    value: typeConversion.toJSValue( v )
                }];
            } else {
                return [ k, {
                    writable: true,
                    enumerable: true,
                    configurable: true,
                    value: v
                }];
            }
        }) );
        Reflect.set( cache, aUUID, Object.create(new this(), objectProperties))
        return cache[ aUUID as keyof object];
    }

    /**
     * Loads objects from the database that match the specified criteria.
     *
     * The `load` method executes a query to retrieve rows from the database table associated with the class.
     * It then deserializes the data into instances of the class, resolving any nested objects or relationships.
     *
     * ## Behavior:
     * - Constructs a `SELECT` query using the provided criteria.
     * - Executes the query and retrieves matching rows from the database.
     * - Deserializes each row into an object of the class, using `TypeCache` to resolve nested objects.
     * - Caches loaded objects to prevent redundant deserialization and resolve circular references.
     *
     * @param {object} criteria - An object representing the filter conditions for the query.
     *   The keys should correspond to column names, and the values specify the desired match.
     * @param {object} [cache] - An optional cache used to store and resolve objects during deserialization.
     *
     * @returns {Storable[]} - An array of objects that match the specified criteria.
     *
     * @throws {Error} - Throws an error if the query fails or if deserialization encounters issues.
     *
     * @remarks
     * - The criteria object is translated into an SQL `WHERE` clause using the `criterion` library.
     * - This method is ideal for retrieving multiple records based on shared attributes or conditions.
     * - Nested objects are automatically rehydrated and linked to the parent objects using `TypeCache`.
     *
     * @see {@link loadWithUUID} - Retrieves a single object by its UUID.
     * @see {@link TypeCache} - Resolves nested objects during deserialization.
     * @see {@link dbColumns} - Determines which columns are queried based on the class schema.
     */
    @log
    public static load( criteria : object, _cache? : object) : Storable[] {        
        const query = `SELECT uuid FROM ${this.tablename}`;
        const where = criterion( criteria );
        const sql = [query, `WHERE ${where.sql()}`].join(" ");
        return DBConnection.prepare(sql).all( where.params() ).map( (row : object) => {
            return this.loadWithUUID( (row as Storable).uuid );
        })
    }
    /**
     * Declares a custom database type and its conversion logic.
     *
     * The `declareDBType` method allows developers to define new database types and specify
     * how they should be handled during serialization and deserialization. This extends the
     * ORM's capabilities to support custom or complex data types.
     *
     * ## Behavior:
     * - Registers the custom type in the `DBTypeConversions` static field.
     * - Specifies how to transform the type between JavaScript and SQLite formats.
     *
     * @param {string} aType - The name of the custom database type (e.g., `UUID`, `JSON`, `DATETIME`).
     * @param {TDBTypeConversion} aDefinition - An object defining the conversion logic for the type:
     *   - `toPlaceholder` (optional): The SQL placeholder to use for this type (e.g., `json(?)`).
     *   - `toDBValue` (optional): A function to convert a JavaScript value to a database-compatible format.
     *   - `toJSValue` (optional): A function to convert a database value back to a JavaScript format.
     *
     * @returns {void}
     *
     * @throws {Error} - Throws an error if the type name or definition is invalid.
     *
     * @remarks
     * - This method is typically called during the setup phase to extend the ORM with new types.
     * - Custom types declared with this method can be used seamlessly in table schemas and object mappings.
     * - Existing types should not be redefined to avoid inconsistencies.
     *
     * @see {@link DBTypeConversions} - Stores the declared types and their conversion logic.
     * @see {@link dbValues} - Uses the declared types to handle value serialization.
     */
    static declareDBType( aType : string, aDefinition : TDBTypeConversion) : void {
        const theClass = (this as Loadable);
        theClass.DBTypeConversions[ aType ] = aDefinition;
    }
}

/**
 * Default database types defined by `Flatter`.
 *
 * `Flatter` provides several built-in database types with associated conversion logic to facilitate
 * seamless integration between JavaScript and SQLite. These default types cover common use cases
 * and ensure consistent handling of data across the ORM.
 *
 * ## Predefined Types:
 *
 * ### `UUID`
 * - Represents a universally unique identifier.
 * - Stored as a `TEXT` type in SQLite.
 * - Automatically assigned to each object upon creation.
 * - Used as the primary key for all tables.
 *
 * ### `TEXT`
 * - Represents a plain text field.
 * - Stored as a `TEXT` type in SQLite.
 * - Requires no additional conversion for JavaScript compatibility.
 *
 * ### `DATETIME`
 * - Represents a date and time value.
 * - Stored as a `TEXT` type in SQLite using ISO 8601 format.
 * - Conversion Logic:
 *   - `toDBValue`: Converts a JavaScript `Date` object to an ISO 8601 string.
 *   - `toJSValue`: Converts an ISO 8601 string back into a JavaScript `Date` object.
 *
 * ### `OBJECT`
 * - Represents a complex or nested object.
 * - Stored as a `JSON` type in SQLite.
 * - Conversion Logic:
 *   - `toDBValue`: Serializes the object to a JSON string.
 *   - Handles nested `Flatter` objects by saving their UUIDs as references.
 *   - `toJSValue`: Deserializes the JSON string back into the original object.
 *   - Reconstructs nested `Flatter` objects using `TypeCache`.
 *
 * ## Behavior:
 * - These types are registered in `DBTypeConversions` during initialization.
 * - They can be extended or customized using the `declareDBType` method.
 * - Ensures compatibility between JavaScript types and SQLite's supported storage classes.
 *
 * @remarks
 * - The `UUID`, `TEXT`, and `DATETIME` types cover most basic use cases for identifiers, strings, and timestamps.
 * - The `OBJECT` type enables the ORM to handle nested and complex object hierarchies.
 * - Custom types can be declared to extend this default set.
 *
 * @see {@link DBTypeConversions} - Stores the conversion logic for all database types.
 * @see {@link declareDBType} - Used to add or override type definitions.
 */
Flatter.declareDBType('UUID', {});
Flatter.declareDBType('TEXT', {});
Flatter.declareDBType('DATETIME', {
    toDBValue    : (e : unknown, _cache : TObjectLoadCache) : string => { return julian( e ) },
// @ts-ignore: this is very definitely what I want to do, but it won't match a generic signature.
    toJSValue    : (e) => { return new Date(e) ; }
});
Flatter.declareDBType('OBJECT', {
    toPlaceholder: 'json(?)',
    toDBValue    : (e: unknown, cache : TObjectLoadCache) : string => {

        /* This replacer function checks to see if what we're trying to flatten is an object.
           If it is, then we check to see if its an instance of Flatter. If it is, then we need
           to be clever. If its the toplevel object, we just return it just as it is. If it isn't
           then first of all we need to replace it with a placeholder, that provides the information
           needed - essentially the class and the uuid - to retrieve the object when we
           deserialize later on. 

           We'll also need to check to see if we've encoutered this object before. If we've not, then
           we call save on it before returning the placeholder. Otherwise, we just return the placeholder.
        */
        const replacer = function(_key : string, value : unknown ) {                        
            if ( value instanceof Flatter && (e as Storable).uuid == value.uuid ) {
                return value;
            } else if (value instanceof Flatter) {
                const proxy = { 
                    class: (value.constructor as ObjectConstructor).name,
                    uuid : (value as Storable).uuid
                };
                value.save( cache )
                return proxy;
            } else {
                return value;
            }
        };

        return JSON.stringify(e,replacer);            
    }
})

export default Flatter;