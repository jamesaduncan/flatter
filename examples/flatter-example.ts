import Flatter from "../Flatter.ts";
//import { assert, assertEquals } from "jsr:@std/assert";

interface IAddress {
    street?: string;
    city?  : string;
    postcode? : string;
}

class Address extends Flatter {
    street : string = "";    
    city   : string  = "";
    postcode : string = "";

    constructor( template? : IAddress ) {
        super();
        if (template) {
            Object.assign(this, template)
        }
    }

    static override SQLDefinition = `
        CREATE TABLE ${this.tablename} (
            uuid UUID PRIMARY KEY NOT NULL,
            street TEXT,
            postcode TEXT,
            city TEXT,
            flatter OBJECT
        )
    `;

    static {
        this.init();
    }
}

interface IUser {
    username : string;
    created?  : Date;

    shippingAddress? : Address;
}

class User extends Flatter implements IUser {
    username : string = "";
    created  : Date = new Date();
    
    shippingAddress : Address = new Address();

    constructor( template? : IUser) {
        super();
        if (template) {
            Object.assign( this, template );
        }
    }

    static override SQLDefinition = `
        CREATE TABLE ${this.tablename} (
            uuid UUID PRIMARY KEY NOT NULL,
            username TEXT UNIQUE NOT NULL,
            created DATETIME,
            shippingAddress Address,
            flatter OBJECT,
            FOREIGN KEY(shippingAddress) REFERENCES Addresses(uuid) ON DELETE CASCADE
        );
    `;

    static {
        this.init();
    }
}

//const theUsername = 'johndoe';

const bill = new User({ 
    username: 'bill', 
    shippingAddress: new Address({ street: '17 West Street', city: 'Wareham'} )
});
bill.save();
console.log(bill);

console.log( User.loadWithUUID( bill.uuid ) );

/* test cases */
/*
Deno.test("simple test", () => {
    assert(true); // this is true
});

Deno.test("creating a user", () => {
    const u = new User();
    assert(u); // got a user
});

Deno.test("create user with some pre-set values", () => {
    const u = new User({ username: theUsername });
    assertEquals(u.username, theUsername);
});

Deno.test("save a user", () => {
    (new User({ username: theUsername })).save();
    assert(true);
});

Deno.test("load a user", () => {
    const u = User.load({username: theUsername })[0];
    assert(u);
});

Deno.test("load a user with a uuid", () => {
    const u = User.load({username: theUsername })[0];
    const u2 = User.loadWithUUID( u.uuid );
    assert((u as User).username == (u2 as User).username);
});
*/
