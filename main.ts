import Flatter from "./Flatter.ts";
import { assert, assertEquals } from "jsr:@std/assert";


class Address extends Flatter {
    street : string = "";    
    city   : string  = "";
    postcode : string = "";

    static override SQLDefinition = `
        CREATE TABLE ${this.tablename} (
            uuid UUID PRIMARY KEY NOT NULL,
            street TEXT,
            postcode TEXT,
            city TEXT
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
            if (template.username) this.username = template.username
        }
    }

    static override SQLDefinition = `
        CREATE TABLE ${this.tablename} (
            uuid UUID PRIMARY KEY NOT NULL,
            username TEXT NOT NULL,
            created DATETIME,
            shippingAddress Address,
            flatter OBJECT,
            FOREIGN KEY(shippingAddress) REFERENCES Addresses(uuid)
        );
    `;

    static {
        this.init();
    }
}

const theUsername = 'johndoe';
const u = new User({ username: theUsername });
u.save();
const u2 = User.load({username: theUsername })
console.log(u2);

/* test cases */

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
 
    assert(true);
});

Deno.test("load a user", () => {

    assert(u);

})