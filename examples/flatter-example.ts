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
        super( template );
        if (template) {
            Object.assign(this, template)
        }
    }

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
    created  : Date   = new Date();
    shippingAddress : Address = new Address();

    constructor( template? : IUser) {
        super();
        if (template) {
            Object.assign( this, template );
        }
    }

    static {
        this.init();
    }
}


