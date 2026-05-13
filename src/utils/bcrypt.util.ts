import bcrypt from 'bcrypt'

class Bcrypt {
  static hash = (string: string) => {
    return bcrypt.hashSync(string, Number(process.env.BCRYPT_SALT_ROUND) || 10)
  }

  static compare = (string: string, hash: string) => {
    return bcrypt.compareSync(string, hash)
  }
}

export default Bcrypt
